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
 * pagándole al cliente por otro medio (`resolveReversedCardRefund`; D670: o «Ya se devolvió en Stripe», con evidencia de Stripe, y si esa
 * devolución de Stripe falla después, la reversa vuelve de `RESOLVED` a `REVERSED`, el único paso hacia atrás). `advanceCardRefund` es el ÚNICO paso que habla con Stripe y
 * nunca corre con una transacción abierta (r4 #5). Siempre la cuenta Stripe de la foto del cargo (`chargeMerchant`).
 *
 * D661 (Task 5) — en «Nadie» (`requiresAcceptance === false`) se devuelve el 100 % o nada (`FULL_REFUND_ONLY`): bajo el candado de la
 * orden, ANTES de hablar con Stripe, la devolución reserva el pedido por entregar (`refundRequestedAt`: ya no se entrega, no lo marca
 * el cierre del día, no se arma comanda ni se reclama papel ni se marca «Listo»). Anotada, el pedido se cierra «Devuelto»
 * (`cerrarComoDevueltoEnTx`); si el proceso muere antes, el barrido de cierres lo hace. Si Stripe no devuelve, el desenlace y el retiro
 * de la reserva de ESE intento van en una sola transacción y la cocina retoma. «Mi equipo» sigue igual: parciales, sin reserva ni cierre.
 *
 * D661 (Task 6) — el otro destino: el 100 % como saldo a favor en el negocio (`devolverASaldoAFavor`). Nada va a Stripe y todo va en
 * UNA transacción (reserva, fila `RESOLVED` a saldo, renglón REFUND con su abono, efectos y cierre «Devuelto»). Antes de devolver un
 * pedido «Nadie» a cualquiera de los dos destinos se lee el cargo en Stripe: una devolución hecha por fuera de Avoqado lo frena (409
 * `EXTERNAL_REFUND_DETECTED`, Ruling 28) y, si Stripe no contesta, no se devuelve a ciegas (503).
 */
import {
  OnlineOrderCardRefundStatus as R,
  OnlineOrderChargeStatus,
  OnlineOrderPaymentMode,
  OnlineOrderStatus,
  PaymentMethod,
  PaymentSource,
  PaymentType,
  Prisma,
  type OnlineOrderCardRefund,
  type OnlineOrderCharge,
} from '@prisma/client'
import logger from '@/config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { operationHash } from '@/utils/operationHash'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { logAction } from '@/services/dashboard/activity-log.service'
import { sendVenueNotification } from '@/services/dashboard/notification.dashboard.service'
import {
  bloquearCobroParaReembolso,
  issueRefund,
  writeRefundInTx,
  type CobroBloqueado,
  type RefundReason,
} from '@/services/dashboard/refund.dashboard.service'
import { abonarSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { getProvider } from '@/services/payments/provider-registry'
import { fromStripeAmount, toStripeAmount } from '@/services/payments/providers/money'
import type {
  ChargeRefunds,
  ProviderRequestLimits,
  RefundState,
  VerifiedWebhookEvent,
} from '@/services/payments/providers/provider.interface'
import { postPayOutInTx } from '@/services/shared/cashDrawerPosting'
import { ajustarRepartoAComponentesRestantes } from '@/services/shared/devueltoDeUnCobro'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { tomarCandadoPrimerSobreSiHaceFaltaEnTx } from '@/services/storeCredit/primerSobreLock'
import { prepararMediosDeSaldoAFavor, resolveStoreCreditTenderInTx, storeCreditAvailable } from '@/services/storeCredit/storeCreditTender'
import { enqueueRefundPaymentEffectsInTx } from '@/services/tpv/paymentEffects.service'
import { reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { PRINT_CLAIM_TTL_MS } from '../constants'
import { comandaAdmitida } from '../printClaim.service'
import { emitOnlineOrderUpdated } from '../traySocket'
import type { CardDraftRequest } from './draft.service'
import { DEVOLUCION_ANOTADA, ENTREGABLE, YA_ENTREGADO, cerrarComoDevueltoEnTx } from './devuelto'
import { chargeMerchant, isForeignStripeEvent } from './merchant'

/** Los motivos que el panel puede escoger (el de las apps de reparto no aplica aquí). */
export const CARD_REFUND_REASONS = ['RETURNED_GOODS', 'ACCIDENTAL_CHARGE', 'CANCELLED_ORDER', 'FRAUDULENT_CHARGE', 'OTHER'] as const
/** Sin renglón del libro todavía: su monto sigue reservado y bloquea otra devolución del mismo cargo. */
const NO_LEDGER_YET: R[] = [R.REQUESTED, R.SENDING, R.PENDING, R.SUCCEEDED]
/** Lo que el recorrido vuelve a mirar. */
export const SWEPT_CARD_REFUND_STATUSES: R[] = [...NO_LEDGER_YET, R.RECORDED]
/** Ya con renglón: su comisión devuelta ya la contó Stripe. */
const WITH_LEDGER: R[] = DEVOLUCION_ANOTADA

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

/** El cargo de la fila con su pedido (la foto del comercio va en el cargo) y si el pedido es de «Nadie» (D661). */
async function chargeOf(row: Row) {
  const charge = await prisma.onlineOrderCharge.findUnique({
    where: { id: row.chargeId },
    include: { onlineOrder: { select: { orderId: true, requiresAcceptance: true } } },
  })
  if (!charge?.onlineOrder || !charge.paymentIntentId) throw new Error(`cargo ${row.chargeId} sin pedido o sin PaymentIntent`)
  return {
    charge,
    orderId: charge.onlineOrder.orderId,
    nadie: charge.onlineOrder.requiresAcceptance === false,
    paymentIntentId: charge.paymentIntentId,
    merchant: chargeMerchant(charge),
  }
}

/**
 * CAS al estado siguiente. Relee la fila; `true` si ESTE llamador ganó el CAS. Los desenlaces sin renglón (`FAILED`/`CANCELED`) van
 * por `terminarSinDevolver` (con `now`: la hora en que la cocina retoma).
 */
async function moveTo(
  cur: Cur,
  to: R,
  data: Prisma.OnlineOrderCardRefundUpdateManyMutationInput = {},
  now: Date = new Date(),
): Promise<boolean> {
  if (to === R.FAILED || to === R.CANCELED) return terminarSinDevolver(cur, to, data, now)
  const from = cur.row.status
  const won = await prisma.onlineOrderCardRefund.updateMany({ where: { id: cur.row.id, status: from }, data: { ...data, status: to } })
  cur.row = (await load(cur.row.id))!
  return won.count === 1
}

/**
 * Stripe no devolvió (`FAILED`/`CANCELED`, sólo con su evidencia). D661 (Task 5, r5 #4): el desenlace y, en «Nadie», el retiro de la
 * reserva de ESTE intento van bajo el candado de la orden y en la MISMA transacción: si el proceso muere después, el pedido no se queda
 * «Devolviendo…» para siempre. Con la reserva retirada vuelve a ser entregable y la cocina retoma. Fuera de la transacción: bitácora y,
 * si había reserva, aviso al negocio.
 */
async function terminarSinDevolver(
  cur: Cur,
  to: R,
  data: Prisma.OnlineOrderCardRefundUpdateManyMutationInput,
  now: Date,
): Promise<boolean> {
  const { orderId } = await chargeOf(cur.row)
  const row = cur.row
  const out = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: row.venueId, orderId }))) {
      throw new Error(`la orden ${orderId} ya no es de este negocio`)
    }
    const cas = await tx.onlineOrderCardRefund.updateMany({ where: { id: row.id, status: row.status }, data: { ...data, status: to } })
    if (cas.count !== 1) return { won: false as const }
    const retirada = await retirarReservaEnTx(tx, { venueId: row.venueId, orderId, chargeId: row.chargeId, cardRefundId: row.id, now })
    return { won: true as const, retirada }
  }, ORDER_LOCK_WAIT_BUDGET)
  cur.row = (await load(row.id))!
  if (!out.won) return false
  logger.warn('⚠️ [OnlineOrderCardRefund] Stripe no devolvió: ningún renglón', { cardRefundId: row.id, status: to })
  void logAction({
    staffId: row.staffId,
    venueId: row.venueId,
    action: 'ONLINE_ORDER_CARD_REFUND_FAILED',
    entity: 'OnlineOrderCardRefund',
    entityId: row.id,
    data: {
      status: to,
      amount: pesos(row.amountCents),
      stripeRefundId: data.stripeRefundId ?? row.stripeRefundId,
      why: data.lastError,
      ...(out.retirada ? { reservaRetirada: true } : {}),
    },
  })
  if (out.retirada) {
    emitOnlineOrderUpdated({
      venueId: row.venueId,
      orderId,
      orderNumber: out.retirada.orderNumber,
      onlineStatus: out.retirada.status,
      now,
    })
    void sendVenueNotification(
      row.venueId,
      {
        type: 'PAYMENT_FAILED',
        title: 'No se pudo devolver un pedido a la tarjeta',
        // D661 (B3): un «No lo recogió» reservado por el papel sigue cerrado; sólo lo por entregar vuelve a «Por entregar».
        message: YA_ENTREGADO.includes(out.retirada.status)
          ? `El banco no aceptó la devolución de $${pesos(row.amountCents)} del pedido ${out.retirada.orderNumber}: no se devolvió nada. El pedido sigue como «No lo recogió»; si la clienta lo reclama, devuélvelo otra vez.`
          : `El banco no aceptó la devolución de $${pesos(row.amountCents)} del pedido ${out.retirada.orderNumber}: no se devolvió nada. El pedido vuelve a «Por entregar»; si la clienta no lo quiere, devuélvelo otra vez.`,
        entityType: 'OnlineOrderCardRefund',
        entityId: row.id,
        priority: 'HIGH',
        metadata: { orderId, cardRefundId: row.id },
      },
      ['OWNER', 'ADMIN', 'MANAGER'],
    ).catch(error =>
      logger.error('[OnlineOrderCardRefund] no se pudo avisar al negocio', { cardRefundId: row.id, error: errorText(error) }),
    )
  }
  return true
}

/**
 * En la transacción del desenlace: quita la reserva si es de ESTE intento (una sola devolución en curso por cargo: si otra del cargo
 * sigue viva o ya quedó anotada, la reserva no es suya). Vuelve a dejar escrita la marca de cocina (`kitchenPendingAt`): mientras la
 * reserva vivió no se armó comanda nueva y el barrido de cocina pudo rendirse (r6 #3); el armado sólo agrega lo que falte.
 * D661 (B3): la reserva de un «No lo recogió» (la puso el papel) también se quita: vuelve a pedir su comanda si sigue en su ventana.
 * Su cocina no se rearma: nadie lo va a recoger.
 */
async function retirarReservaEnTx(
  tx: Prisma.TransactionClient,
  i: { venueId: string; orderId: string; chargeId: string; cardRefundId: string; now: Date },
): Promise<{ orderNumber: string; status: OnlineOrderStatus } | null> {
  const pedido = await tx.onlineOrder.findFirst({
    where: { orderId: i.orderId, venueId: i.venueId },
    select: { id: true, status: true, requiresAcceptance: true, refundRequestedAt: true, order: { select: { orderNumber: true } } },
  })
  if (pedido?.requiresAcceptance !== false || !pedido.refundRequestedAt) return null
  const otra = await tx.onlineOrderCardRefund.findFirst({
    where: { chargeId: i.chargeId, id: { not: i.cardRefundId }, status: { in: [...NO_LEDGER_YET, ...WITH_LEDGER] } },
    select: { id: true },
  })
  if (otra) return null
  const retirada = await tx.onlineOrder.updateMany({
    where: {
      id: pedido.id,
      orderId: i.orderId,
      venueId: i.venueId,
      requiresAcceptance: false,
      status: { in: [...ENTREGABLE, ...YA_ENTREGADO] },
      refundRequestedAt: { not: null },
      refundedAt: null,
    },
    data: { refundRequestedAt: null },
  })
  if (retirada.count !== 1) return null
  if (ENTREGABLE.includes(pedido.status)) {
    await tx.order.updateMany({ where: { id: i.orderId, venueId: i.venueId }, data: { kitchenPendingAt: i.now } })
  }
  return { orderNumber: pedido.order.orderNumber, status: pedido.status }
}

/**
 * El cierre «Devuelto» en su propia transacción (con el presupuesto del candado de la orden) y, ya confirmado, el aviso a la bandeja.
 * `true` si ESTA llamada lo cerró. Lo usan la devolución al anotarse y el barrido de cierres.
 */
export async function cerrarComoDevuelto(i: { venueId: string; orderId: string; now: Date; staffId: string | null }): Promise<boolean> {
  const cierre = await prisma.$transaction(tx => cerrarComoDevueltoEnTx(tx, i), ORDER_LOCK_WAIT_BUDGET)
  if (!cierre.cerrado) return false
  emitOnlineOrderUpdated({
    venueId: i.venueId,
    orderId: i.orderId,
    orderNumber: cierre.orderNumber,
    onlineStatus: OnlineOrderStatus.COMPLETED,
    now: i.now,
  })
  return true
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
async function send(cur: Cur, now: Date, limites?: ProviderRequestLimits): Promise<void> {
  const won = await prisma.onlineOrderCardRefund.updateMany({
    where: { id: cur.row.id, status: R.REQUESTED },
    data: { status: R.SENDING, nextCheckAt: nextPendingCheck(cur.row.createdAt, now), lastSentAt: now },
  })
  if (won.count !== 1) {
    cur.row = (await load(cur.row.id))!
    return
  }
  cur.row = { ...cur.row, status: R.SENDING, nextCheckAt: nextPendingCheck(cur.row.createdAt, now), lastSentAt: now }
  await callStripeRefund(cur, now, limites)
}

/**
 * El envío a Stripe de una fila ya `SENDING`, con la MISMA clave siempre (Stripe repite o crea exactamente una). D661 (ronda 2 de
 * codex-r3, Ruling 73): con `limites` (el recorrido), su plazo duro: si se cumple, la fila sigue `SENDING` y se busca/reenvía igual.
 */
async function callStripeRefund(cur: Cur, now: Date, limites?: ProviderRequestLimits): Promise<void> {
  const { orderId, paymentIntentId, merchant } = await chargeOf(cur.row)
  // Codex r3 #3: un cobro hecho a mano en Stripe no trae comisión de la plataforma; no se pide devolver una que no existe.
  const cobro = await prisma.payment.findFirst({
    where: { venueId: cur.row.venueId, orderId, processorId: paymentIntentId, type: PaymentType.REGULAR },
    select: { feeAmount: true },
  })
  const params = {
    paymentIntentId,
    amount: cur.row.amountCents,
    refundApplicationFee: !cobro?.feeAmount || new Prisma.Decimal(cobro.feeAmount).gt(0),
    idempotencyKey: `online-order:${orderId}:refund:${cur.row.id}`,
    metadata: { type: 'online_order_refund', cardRefundId: cur.row.id, orderId, venueId: cur.row.venueId },
  }
  const provider = getProvider(merchant)
  let result
  try {
    result = await (limites ? provider.refund(merchant, params, limites) : provider.refund(merchant, params))
  } catch (error) {
    // Stripe rechazó la solicitud (p. ej. un cobro en disputa): la devolución no existe; nada se movió.
    if (stripeRejected(error)) {
      await moveTo(cur, R.FAILED, { lastError: errorText(error) }, now)
      return
    }
    throw error // respuesta perdida: queda SENDING (desconocido) y se busca por metadata
  }
  const to = STATUS_OF[result.status]
  await moveTo(cur, to, { stripeRefundId: result.refundId, lastError: null, ...afterStripe(to, cur.row, now) }, now)
}

/** `SENDING` sin id = desconocido: se busca en Stripe por `metadata.cardRefundId`; si no aparece, sigue SENDING (nunca FAILED por tiempo). */
async function findSent(cur: Cur, now: Date, limites?: ProviderRequestLimits): Promise<void> {
  const { paymentIntentId, merchant } = await chargeOf(cur.row)
  const provider = getProvider(merchant)
  const refunds = await (limites
    ? provider.listRefunds(merchant, paymentIntentId, limites)
    : provider.listRefunds(merchant, paymentIntentId))
  const found = refunds.find(r => r.metadata?.cardRefundId === cur.row.id)
  if (found) {
    const to = STATUS_OF[found.status]
    await moveTo(cur, to, { stripeRefundId: found.refundId, lastError: null, ...afterStripe(to, cur.row, now) }, now)
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
      await callStripeRefund(cur, now, limites)
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
async function poll(cur: Cur, now: Date, limites?: ProviderRequestLimits): Promise<void> {
  const { merchant } = await chargeOf(cur.row)
  const provider = getProvider(merchant)
  const state = await (limites
    ? provider.getRefund(merchant, cur.row.stripeRefundId!, limites)
    : provider.getRefund(merchant, cur.row.stripeRefundId!))
  if (state.status === 'PENDING') return touch(cur, nextPendingCheck(cur.row.createdAt, now))
  const to = STATUS_OF[state.status]
  await moveTo(cur, to, { lastError: state.failureReason, ...afterStripe(to, cur.row, now) }, now)
}

/**
 * `SUCCEEDED` → el renglón del libro. La comisión devuelta se LEE de Stripe (no documenta el redondeo; r4 #3) y se guarda antes de
 * escribir: con una sola devolución activa por cargo, el total devuelto menos lo ya guardado es exactamente la de ésta. Luego
 * `issueRefund` (el envoltorio completo: sello, comisiones y referidos encolados; r5 #3) con la llave `oocr_<id>`: si el proceso
 * muere antes del CAS, la siguiente pasada recupera el MISMO renglón.
 */
async function record(cur: Cur, now: Date, limites?: ProviderRequestLimits): Promise<void> {
  const { orderId, nadie, paymentIntentId, merchant } = await chargeOf(cur.row)
  if (cur.row.feeRefundedCents == null) {
    const provider = getProvider(merchant)
    const total = await (limites
      ? provider.getApplicationFeeRefundedCents(merchant, paymentIntentId, limites)
      : provider.getApplicationFeeRefundedCents(merchant, paymentIntentId))
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
    // D661 (Task 5): anotada, el pedido de «Nadie» se cierra «Devuelto». Si esto falla o el proceso muere aquí, el barrido de cierres
    // lo cierra; mientras, la reserva impide entregarlo y que el cierre del día lo marque. Nunca tumba lo ya anotado.
    if (nadie) {
      await cerrarComoDevuelto({ venueId: cur.row.venueId, orderId, now, staffId: cur.row.staffId }).catch(error =>
        logger.warn('⚠️ [OnlineOrderCardRefund] el pedido no se cerró «Devuelto»; el barrido lo cierra', {
          cardRefundId: cur.row.id,
          orderId,
          error: errorText(error),
        }),
      )
    }
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
async function reviewLate(cur: Cur, now: Date, limites?: ProviderRequestLimits): Promise<void> {
  const { orderId, paymentIntentId, merchant } = await chargeOf(cur.row)
  const provider = getProvider(merchant)
  const state = await (limites
    ? provider.getRefund(merchant, cur.row.stripeRefundId!, limites)
    : provider.getRefund(merchant, cur.row.stripeRefundId!))
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
 * error no cambia el estado financiero: anota `lastError`, mueve `nextCheckAt` (r5 #4) y se re-lanza. D661 (ronda 2 de codex-r3,
 * Ruling 73): `limites` sólo los pasa el recorrido (corre bajo la bandera del job del conciliador): cada llamada a Stripe, con su plazo.
 */
async function advance(id: string, now: Date, limites?: ProviderRequestLimits): Promise<{ status: R; alerted: boolean }> {
  const row = await load(id)
  if (!row) throw new NotFoundError('Devolución no encontrada')
  const cur: Cur = { row, alerted: false }
  try {
    switch (cur.row.status) {
      case R.REQUESTED:
        await send(cur, now, limites)
        break
      case R.SENDING:
        await findSent(cur, now, limites)
        break
      case R.PENDING:
        await poll(cur, now, limites)
        break
      case R.SUCCEEDED:
        break
      case R.RECORDED:
        // Fix r1 M2: la revisión tardía PRIMERO; un sello que falla siempre nunca tapa la detección de un fallo de Stripe.
        await reviewLate(cur, now, limites)
        break
      case R.REVERSED:
      case R.RESOLVED:
        if (cur.row.stampReversedAt) return { status: cur.row.status, alerted: false }
        break // sólo queda la reversa del sello
      default:
        return { status: cur.row.status, alerted: false } // FAILED, CANCELED: ya terminó
    }
    if (cur.row.status === R.SUCCEEDED) await record(cur, now, limites)
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

/** Para el recorrido: además del estado, si esta pasada levantó la alerta. Ronda 2 de codex-r3: con el plazo de la pasada. */
export async function advanceCardRefundForSweep(id: string, now: Date, limites?: ProviderRequestLimits) {
  return advance(id, now, limites)
}

/** Ruling 9: un reclamo de papel vigente (sin confirmar y de menos de 90 s): la comanda puede estar saliendo. */
const papelEnVuelo = (p: { printClaimedAt: Date | null; printedAt: Date | null }, now: Date) =>
  p.printClaimedAt != null && p.printedAt == null && p.printClaimedAt.getTime() >= now.getTime() - PRINT_CLAIM_TTL_MS
const papelEnVueloError = () => new ConflictError('Se está imprimiendo la comanda; intenta en un momento', 'PRINT_IN_FLIGHT')

export type CardRefundOutcome = 'RECORDED' | 'PENDING' | 'FAILED' | 'UNKNOWN'
/** D661: a dónde va el dinero. `CARD` (por omisión) a la tarjeta; `STORE_CREDIT`, saldo a favor en el negocio (sólo «Nadie»). */
export type CardRefundDestino = 'CARD' | 'STORE_CREDIT'
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

export interface CardRefundRequest {
  venueId: string
  orderId: string
  amount: Prisma.Decimal
  reason: RefundReason
  staffId: string
  idempotencyKey: string
  note?: string | null
  /** La última devolución que vio quien decide (`null`: ninguna). Se congela al ver la lista; nunca se relee para mandarla. */
  expectedLatestRefundId: string | null
  /** D661: `CARD` por omisión. */
  destino?: CardRefundDestino
  /** D661 (MCP): lo que dijo la vista previa (el pedido se cierra «Devuelto»); se revalida bajo el candado. */
  efectoEsperado?: { cierraComoDevuelto: boolean }
}
export interface CardRefundResult {
  status: CardRefundOutcome
  cardRefundStatus: R
  cardRefundId: string
  refundId: string | null
  replay: boolean
}
/** La solicitud ya validada (centavos, nota limpia, huella y destino), la que reciben los pasos de abajo. */
type Solicitud = CardRefundRequest & { amountCents: number; note: string | null; requestHash: string; destino: CardRefundDestino }

/** Una devolución que Stripe todavía cuenta: viva o hecha (una fallida o cancelada no devolvió nada). */
const DEVOLUCION_VIVA_EN_STRIPE = new Set<RefundState['status']>(['PENDING', 'SUCCEEDED'])

/**
 * D661 (Task 6, Ruling 28): cuánto devolvió Stripe de este cargo por fuera de Avoqado (directo en Stripe), en centavos: sus
 * devoluciones vivas (hechas o pendientes) que no son de las filas de ESTE cargo, más lo que `amount_refunded` traiga por encima de
 * TODAS las listadas (la lista viene completa). D668: «todas», también las fallidas y canceladas: Stripe no documenta si
 * `amount_refunded` descuenta una devolución que falló, y si la siguiera sumando cada devolución revertida se leería «por fuera».
 * `nuestras`: id de cada fila de este cargo → su `stripeRefundId` (null si aún no lo sabemos). Una devolución es nuestra si su metadata
 * nombra una fila Y es la que esa fila guardó (D668, Codex r1 #2: otra devolución con la metadata copiada de la fallida es de fuera).
 * Una fila sin id todavía es dueña de UNA sola: si dos devoluciones distintas la nombran, ninguna cuenta como nuestra (Codex r2 #2;
 * nuestros re-envíos usan la misma clave, así que Stripe nunca nos da dos).
 */
const filaNombrada = (r: ChargeRefunds['refunds'][number]) =>
  r.metadata?.type === 'online_order_refund' ? r.metadata.cardRefundId : undefined
type DevolucionDeStripe = ChargeRefunds['refunds'][number]
/** Las devoluciones de Stripe de este cargo que no son de ninguna fila nuestra, en cualquier estado (D670 las usa también). */
function devolucionesDeFuera(estado: ChargeRefunds, nuestras: ReadonlyMap<string, string | null>): DevolucionDeStripe[] {
  const reclamos = new Map<string, Set<string>>()
  for (const r of estado.refunds) {
    const id = filaNombrada(r)
    if (id !== undefined) reclamos.set(id, (reclamos.get(id) ?? new Set()).add(r.refundId))
  }
  return estado.refunds.filter(r => {
    const id = filaNombrada(r)
    const guardada = id === undefined ? undefined : nuestras.get(id)
    return !(guardada === r.refundId || (guardada === null && reclamos.get(id!)!.size === 1))
  })
}
const sumaCents = (xs: Array<{ amountCents: number }>) => xs.reduce((s, x) => s + x.amountCents, 0)
function devueltoPorFueraCents(estado: ChargeRefunds, nuestras: ReadonlyMap<string, string | null>): number {
  const ajenasVivas = sumaCents(devolucionesDeFuera(estado, nuestras).filter(r => DEVOLUCION_VIVA_EN_STRIPE.has(r.status)))
  return ajenasVivas + Math.max(0, estado.amountRefundedCents - sumaCents(estado.refunds))
}

/** D661 (Task 6, Ruling 28): ¿alguien devolvió este cargo por fuera de Avoqado (directo en Stripe)? */
export function hayDevolucionPorFuera(estado: ChargeRefunds, nuestras: ReadonlyMap<string, string | null>): boolean {
  return devueltoPorFueraCents(estado, nuestras) > 0
}

const MENSAJE_POR_FUERA =
  'Este cobro ya tiene una devolución hecha fuera de Avoqado, directo en Stripe: termínala desde Stripe. Aquí no se devolvió ni se abonó nada.'

/**
 * D661 (Task 6, Ruling 28): fuera de toda transacción, antes de devolver un pedido «Nadie» a cualquier destino, se lee el cargo en
 * Stripe. Con una devolución hecha por fuera → 409 y nada se reserva, abona ni manda. Si Stripe no contesta, falla cerrado con un error
 * que se puede reintentar: nunca se abona sobre una lectura que no contestó. D668: también antes de «Devolver por otro medio»
 * (`mensaje` recibe lo devuelto por fuera, en pesos).
 */
type CargoEnStripe = {
  id: string
  venueId: string
  paymentIntentId: string
  ecommerceMerchantId: string
  merchantSnapshot: Prisma.JsonValue
}

/**
 * Lo que Stripe dice HOY de las devoluciones de este cargo, fuera de toda transacción: las de fuera de Avoqado y lo devuelto por fuera
 * que frena (Ruling 28 / D668). Si Stripe no contesta, falla cerrado con un 503 que se puede reintentar.
 */
async function leerDevolucionesPorFuera(charge: CargoEnStripe): Promise<{
  estado: ChargeRefunds
  deFuera: DevolucionDeStripe[]
  porFueraCents: number
}> {
  const merchant = chargeMerchant(charge)
  let estado: ChargeRefunds
  try {
    estado = await getProvider(merchant).getChargeRefunds(merchant, charge.paymentIntentId)
  } catch (error) {
    logger.warn('⚠️ [OnlineOrderCardRefund] no se pudo leer el cargo en Stripe: no se devuelve sin saberlo', {
      chargeId: charge.id,
      error: errorText(error),
    })
    throw new ServiceUnavailableError(
      'No pudimos revisar en Stripe si este cobro ya se devolvió por fuera de Avoqado. Intenta de nuevo en un momento; no se aplicó nada.',
      'STRIPE_REFUND_CHECK_UNAVAILABLE',
    )
  }
  // D668 (Codex r1 #4): sólo las filas que la metadata de Stripe nombra, todas (antes, las primeras 50 del cargo: un «Mi equipo» con
  // más parciales leía una propia como de fuera). La lista de Stripe ya viene acotada (el adaptador falla al llegar a su tope).
  const nombradas = [
    ...new Set(
      estado.refunds.flatMap(r => (r.metadata?.type === 'online_order_refund' && r.metadata.cardRefundId ? [r.metadata.cardRefundId] : [])),
    ),
  ]
  const filas = nombradas.length
    ? await prisma.onlineOrderCardRefund.findMany({
        where: { venueId: charge.venueId, chargeId: charge.id, id: { in: nombradas } },
        select: { id: true, stripeRefundId: true },
        take: nombradas.length,
      })
    : []
  const nuestras = new Map(filas.map(r => [r.id, r.stripeRefundId]))
  return { estado, deFuera: devolucionesDeFuera(estado, nuestras), porFueraCents: devueltoPorFueraCents(estado, nuestras) }
}

async function exigirSinDevolucionPorFuera(
  charge: CargoEnStripe,
  mensaje: (porFuera: string) => string = () => MENSAJE_POR_FUERA,
): Promise<void> {
  const { estado, porFueraCents: porFuera } = await leerDevolucionesPorFuera(charge)
  if (!porFuera) return
  logger.error('🚨 [OnlineOrderCardRefund] el cargo ya tiene una devolución hecha fuera de Avoqado: no se devuelve otra vez', {
    chargeId: charge.id,
    venueId: charge.venueId,
    amountRefunded: pesos(estado.amountRefundedCents),
    porFuera: pesos(porFuera),
  })
  throw new ConflictError(mensaje(pesos(porFuera)), 'EXTERNAL_REFUND_DETECTED')
}

/**
 * D661 (Task 6): lo que va FUERA de toda transacción y antes de los candados, sólo para un pedido «Nadie» y una llave nueva (una
 * repetición o una llave ajena la contesta la transacción, sin Stripe): saldo a favor sin las llaves del servidor → 422; el cargo en
 * Stripe (Ruling 28); y los medios de sistema del saldo (con el cliente global: un P2002 dentro abortaría la transacción de dinero).
 * «Mi equipo» no lee nada de más. Sin cargo de tarjeta, la transacción contesta como siempre (`NOT_A_CARD_ONLINE_ORDER`).
 */
async function antesDeLosCandados(s: Solicitud): Promise<void> {
  const cargo = await prisma.onlineOrderCharge.findFirst({
    where: {
      venueId: s.venueId,
      onlineOrder: { is: { orderId: s.orderId, venueId: s.venueId, paymentMode: OnlineOrderPaymentMode.CARD_ONLINE } },
    },
    select: {
      id: true,
      venueId: true,
      status: true,
      paymentIntentId: true,
      ecommerceMerchantId: true,
      merchantSnapshot: true,
      onlineOrder: { select: { requiresAcceptance: true } },
    },
  })
  if (cargo?.onlineOrder?.requiresAcceptance !== false) return
  const previa = await prisma.onlineOrderCardRefund.findUnique({
    where: { chargeId_key: { chargeId: cargo.id, key: s.idempotencyKey } },
    select: { id: true },
  })
  if (previa) return
  if (s.destino === 'STORE_CREDIT' && !storeCreditAvailable()) {
    throw new AppError(
      'El saldo a favor no está activo en Avoqado para este negocio. Puedes devolverlo a su tarjeta; no se aplicó nada.',
      422,
      true,
      'STORE_CREDIT_UNAVAILABLE',
    )
  }
  if (cargo.status === OnlineOrderChargeStatus.CAPTURED && cargo.paymentIntentId) {
    await exigirSinDevolucionPorFuera({ ...cargo, paymentIntentId: cargo.paymentIntentId })
  }
  if (s.destino === 'STORE_CREDIT') await prepararMediosDeSaldoAFavor(s.venueId)
}

type SaldoDelPago = { customerId: string; telefonoVerificado: string | null; folio: string }
type Decision =
  | { replay: true; id: string }
  | {
      replay: false
      charge: OnlineOrderCharge
      cobro: CobroBloqueado
      /** El pedido que esta solicitud reservó (sólo «Nadie» por entregar). */
      reservado: { orderNumber: string; status: OnlineOrderStatus; at: Date } | null
      /** La hora de la decisión (la de la reserva, la del renglón y la del cierre). */
      ahora: Date
      /** Sólo con `STORE_CREDIT`: la clienta del pago, el teléfono que verificó al pagar (Task 2, del borrador) y el folio. */
      saldo: SaldoDelPago | null
    }

/**
 * Bajo el candado de la orden, lo que comparten los dos destinos (sin escribir nada salvo la reserva): 1) la repetición primero (misma
 * llave del cliente en este cargo; otra solicitud con la misma llave → 409, sin avanzar nada); 2) otra devolución en curso del cargo →
 * 409; 3) cargo `CAPTURED` y el importe cabe en lo que queda por devolver del cobro de Stripe según el cálculo de siempre (cuenta todo
 * REFUND del libro, también un «Cambio» con saldo a favor) menos lo reservado por las filas sin renglón (ruling 2). En «Nadie»: 100 %
 * (`FULL_REFUND_ONLY`), el efecto que vio el MCP se revalida (`REFUND_EFFECT_CHANGED`) y, si el pedido está por entregar, se reserva
 * aquí mismo — con el papel de la comanda saliendo no (`PRINT_IN_FLIGHT`, Ruling 9; también fuera de la ventana, Ruling 44). Candados:
 * Order → Payment → OnlineOrder.
 * D661 (Task 6): el saldo a favor sólo es de «Nadie» (`REFUND_DESTINATION_NOT_AVAILABLE` en «Mi equipo») y pide la clienta del pago.
 */
async function decidirDevolucionEnTx(tx: Prisma.TransactionClient, s: Solicitud): Promise<Decision> {
  if (!(await lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: s.orderId }))) {
    throw new NotFoundError('Pedido no encontrado')
  }
  const online = await tx.onlineOrder.findFirst({
    where: { orderId: s.orderId, venueId: s.venueId },
    select: {
      id: true,
      paymentMode: true,
      requiresAcceptance: true,
      status: true,
      printClaimedAt: true,
      printedAt: true,
      notPickedUpAt: true,
      refundRequestedAt: true,
      refundedAt: true,
      order: { select: { orderNumber: true } },
      charge: true,
    },
  })
  const charge = online?.paymentMode === OnlineOrderPaymentMode.CARD_ONLINE ? online.charge : null
  if (!online || !charge) throw new BadRequestError('Este pedido no se pagó con tarjeta en línea.', 'NOT_A_CARD_ONLINE_ORDER')

  const previa = await tx.onlineOrderCardRefund.findUnique({
    where: { chargeId_key: { chargeId: charge.id, key: s.idempotencyKey } },
  })
  if (previa) {
    if (previa.requestHash !== s.requestHash) {
      throw new ConflictError('La llave de idempotencia ya pertenece a otra devolución', 'IDEMPOTENCY_KEY_REUSED')
    }
    return { replay: true, id: previa.id }
  }
  // D661: en «Nadie» la tienda promete el saldo a favor; «Mi equipo» sigue sólo a la tarjeta (con parciales, sin reserva ni cierre).
  const nadie = online.requiresAcceptance === false
  let saldo: SaldoDelPago | null = null
  if (s.destino === 'STORE_CREDIT') {
    if (!nadie) {
      throw new BadRequestError(
        'Este pedido sólo se devuelve a la tarjeta: el saldo a favor es para los pedidos que entran solos. No se aplicó nada.',
        'REFUND_DESTINATION_NOT_AVAILABLE',
      )
    }
    const borrador = (charge.request ?? {}) as unknown as Partial<CardDraftRequest>
    if (!borrador.customerId) {
      throw new GiftCardError(
        'STORE_CREDIT_CUSTOMER_REQUIRED',
        'Este pedido no tiene una clienta con cuenta: no hay a quién abonarle el saldo a favor. Puedes devolverlo a su tarjeta; no se aplicó nada.',
        400,
      )
    }
    saldo = {
      customerId: borrador.customerId,
      telefonoVerificado: borrador.telefonoVerificado ?? null,
      folio: online.order.orderNumber,
    }
  }
  // La protección contra devolver dos veces (Codex panel r4): dos solicitudes con la misma vista no pueden pasar las dos, sin
  // importar el orden, la demora, las pestañas, las personas ni el destino. Cuenta toda fila, también FAILED: el mismo orden que
  // `listCardRefunds`.
  const ultima = await tx.onlineOrderCardRefund.findFirst({
    where: { chargeId: charge.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  if ((ultima?.id ?? null) !== s.expectedLatestRefundId) {
    throw new ConflictError('Hubo otra devolución de este pedido. Revisa la lista antes de devolver.', 'CARD_REFUND_STALE_VIEW')
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
    where: { venueId: s.venueId, orderId: s.orderId, processorId: charge.paymentIntentId, type: PaymentType.REGULAR },
    select: { id: true },
  })
  if (!payment) throw new ConflictError('No se encontró el cobro de la tarjeta de este pedido.', 'CARD_PAYMENT_NOT_FOUND')
  // Ruling 2 + fix r1: lo que queda por devolver del cobro de Stripe YA descuenta todo REFUND del libro (también un «Cambio») y
  // lo apartado por devoluciones a la tarjeta sin renglón todavía: el candado compartido lo calcula para todos los caminos.
  const cobro = await bloquearCobroParaReembolso(tx, { venueId: s.venueId, paymentId: payment.id, expectedOrderId: s.orderId })
  const disponible = cobro.remainingBeforeCents
  if (s.amountCents > disponible) {
    throw new BadRequestError(
      `No se puede devolver $${pesos(s.amountCents)}: de este pedido sólo quedan $${pesos(Math.max(0, disponible))} por devolver.`,
      'CARD_REFUND_EXCEEDS_REMAINING',
    )
  }
  // D661 (Task 5): en «Nadie» la clienta recibe siempre el 100 %: lo que queda por devolver del cobro, completo.
  if (nadie && s.amountCents < disponible) {
    throw new BadRequestError(`Este pedido se devuelve completo: $${pesos(disponible)}. No se aplicó nada.`, 'FULL_REFUND_ONLY')
  }
  // Se reserva (y, anotada, se cierra «Devuelto» desde la reserva) el que todavía está por entregar.
  const reserva = nadie && ENTREGABLE.includes(online.status)
  if (s.efectoEsperado && s.efectoEsperado.cierraComoDevuelto !== reserva) {
    throw new ConflictError(
      'El pedido cambió desde la vista previa (se entregó, se cerró o ya no se puede entregar). Pide una vista previa nueva. No se aplicó nada.',
      'REFUND_EFFECT_CHANGED',
    )
  }
  const reservadaEn = new Date()
  // Ruling 9: con un reclamo de papel en vuelo no se devuelve (la comanda puede estar saliendo ahora). D661 (D, Ruling 44): en «Nadie»,
  // a cualquier destino y aunque la regla del papel ya no admita reclamos NUEVOS: el fin de la ventana de 2 h de un «No lo recogió»
  // sólo frena los nuevos; el que ganó justo antes sigue imprimiendo hasta 90 s.
  if (nadie && papelEnVuelo(online, reservadaEn)) throw papelEnVueloError()
  // D661 (B3): si la regla del papel todavía admite su comanda (por entregar, o un «No lo recogió» dentro de su ventana), mientras se
  // devuelve tampoco debe salir: también se reserva, a cualquier destino (el saldo cierra en esta misma transacción con `refundedAt`).
  const pidePapel = nadie && comandaAdmitida(online, reservadaEn)
  if (reserva || pidePapel) {
    // La reserva ANTES de mover dinero, bajo este candado (el que también toma «Entregado»: su CAS no repite las marcas). El
    // reclamo de papel y el cierre del día NO toman el candado: el CAS repite sus condiciones y cada uno repite las suyas
    // (`refundRequestedAt: null`), así que de los dos gana uno solo.
    const reservada = await tx.onlineOrder.updateMany({
      where: {
        id: online.id,
        requiresAcceptance: false,
        paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
        status: { in: reserva ? ENTREGABLE : YA_ENTREGADO },
        refundRequestedAt: null,
        refundedAt: null,
        OR: [
          { printClaimedAt: null },
          { printedAt: { not: null } },
          { printClaimedAt: { lt: new Date(reservadaEn.getTime() - PRINT_CLAIM_TTL_MS) } },
        ],
      },
      data: { refundRequestedAt: reservadaEn },
    })
    if (reservada.count !== 1) {
      const ahora = await tx.onlineOrder.findFirst({ where: { id: online.id }, select: { printClaimedAt: true, printedAt: true } })
      if (ahora && papelEnVuelo(ahora, reservadaEn)) throw papelEnVueloError()
      throw new ConflictError(
        'El pedido cambió mientras se reservaba la devolución (por ejemplo, lo cerró el fin del día). Vuelve a intentarlo; no se aplicó nada.',
        'ORDER_STATE_CHANGED',
      )
    }
  }
  return {
    replay: false,
    charge,
    cobro,
    reservado: reserva || pidePapel ? { orderNumber: online.order.orderNumber, status: online.status, at: reservadaEn } : null,
    ahora: reservadaEn,
    saldo,
  }
}

/**
 * Devolver un pedido cobrado con tarjeta en línea. A la tarjeta: la decisión (`decidirDevolucionEnTx`) y la fila `REQUESTED` en una
 * transacción; commit y DESPUÉS avanza (r4 #5). Si avanzar truena, la fila queda para el recorrido y se contesta `UNKNOWN`.
 *
 * D661 (Task 5): el destino entra a la huella SÓLO si es `STORE_CREDIT` (la repetición de una fila escrita antes de D661 sigue siendo
 * repetición). D661 (Task 6): a saldo a favor va por `devolverASaldoAFavor` (local, sin Stripe, todo en una transacción); y antes de
 * devolver un pedido «Nadie» a cualquier destino se revisa en Stripe que nadie lo haya devuelto por fuera (Ruling 28).
 */
export async function refundCardOnlineOrder(i: CardRefundRequest): Promise<CardRefundResult> {
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
  const destino: CardRefundDestino = i.destino ?? 'CARD'
  const requestHash = operationHash({ amountCents, reason: i.reason, note, ...(destino === 'STORE_CREDIT' ? { destino } : {}) })
  const s: Solicitud = { ...i, amountCents, note, requestHash, destino }

  await antesDeLosCandados(s)
  if (destino === 'STORE_CREDIT') return devolverASaldoAFavor(s)

  const decided = await prisma.$transaction(async tx => {
    const d = await decidirDevolucionEnTx(tx, s)
    if (d.replay) return { id: d.id, replay: true, reservado: null }
    const row = await tx.onlineOrderCardRefund.create({
      data: {
        venueId: i.venueId,
        chargeId: d.charge.id,
        key: i.idempotencyKey,
        amountCents,
        reason: i.reason,
        staffId: i.staffId,
        note,
        requestHash,
      },
      select: { id: true },
    })
    return { id: row.id, replay: false, reservado: d.reservado }
  }, ORDER_LOCK_WAIT_BUDGET)

  // D661: «Devolviendo…» se ve en la bandeja (después del commit).
  if (decided.reservado) {
    emitOnlineOrderUpdated({
      venueId: i.venueId,
      orderId: i.orderId,
      orderNumber: decided.reservado.orderNumber,
      onlineStatus: decided.reservado.status,
      now: decided.reservado.at,
    })
  }

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

const NOTA_SALDO_A_FAVOR = 'Saldo a favor (pedido en línea)'

/**
 * D661 (C1): lo que queda por devolver del cobro con tarjeta de un pedido, en pesos, con el MISMO cálculo que exige la devolución
 * (`bloquearCobroParaReembolso`: lo ya devuelto en el libro y lo apartado por devoluciones a la tarjeta todavía sin renglón). Lo usa
 * la vista previa del MCP para no prometer lo que se rechazaría al confirmar. Una transacción corta que sólo lee (toma el candado
 * del cobro un instante, como cualquier devolución). Sin cobro con tarjeta: 0.
 */
export async function porDevolverDeUnPedido(venueId: string, orderId: string): Promise<Prisma.Decimal> {
  return prisma.$transaction(async tx => {
    const charge = await tx.onlineOrderCharge.findFirst({
      where: { venueId, onlineOrder: { is: { orderId, venueId } } },
      select: { status: true, paymentIntentId: true },
    })
    if (charge?.status !== OnlineOrderChargeStatus.CAPTURED || !charge.paymentIntentId) return new Prisma.Decimal(0)
    const payment = await tx.payment.findFirst({
      where: { venueId, orderId, processorId: charge.paymentIntentId, type: PaymentType.REGULAR },
      select: { id: true },
    })
    if (!payment) return new Prisma.Decimal(0)
    const cobro = await bloquearCobroParaReembolso(tx, { venueId, paymentId: payment.id, expectedOrderId: orderId })
    return new Prisma.Decimal(cobro.remainingBeforeCents).div(100)
  }, ORDER_LOCK_WAIT_BUDGET)
}

/**
 * D661 (Task 6): devolver el 100 % de un pedido «Nadie» como saldo a favor en el negocio. Local y atómico: nada va a Stripe (el
 * negocio conserva el cobro) y en UNA transacción —la reserva si estaba por entregar, la fila `RESOLVED` con `toStoreCredit` (nunca
 * `REQUESTED`: el recorrido de Stripe no la toma), el renglón REFUND por `writeRefundInTx` (medio de sistema «Saldo a favor»: fuera
 * del cajón y del banco) con su abono al sobre de la clienta, sus efectos y el cierre «Devuelto»—. Si cualquier escritura falla, no
 * queda nada. Candados: «primer-sobre» primero (como exige `writeRefundInTx` con saldo a favor), después Order → Payment →
 * OnlineOrder (`decidirDevolucionEnTx`) → la clienta y su sobre (`prepararSobreDeSaldoAFavorEnTx`, dentro del núcleo).
 *
 * D661 (C4): va por el núcleo (`writeRefundInTx`), no por `issueRefund`, y se salta A PROPÓSITO tres cosas de `issueRefund`:
 * - el gancho de tarjetas de regalo (`alRegistrarReembolsoEnTx`): el cobro de un pedido en línea es un cargo de Stripe, nunca un pago
 *   con saldo, y la tienda en línea no vende tarjetas; el único sobre que se toca es el de la clienta, y lo abona aquí mismo el núcleo;
 * - la obligación de costo negativo: Stripe no devolvió nada (el negocio conserva el cobro y su comisión), igual que `issueRefund`
 *   la salta con saldo a favor;
 * - el recibo digital de la devolución, que `issueRefund` genera después del commit: no lo pidió el plan; lo que la clienta recibe es
 *   saldo en su sobre, y el seguimiento del pedido dice «Devuelto».
 * Lo que sí hace igual: el sello y los puntos se revierten por los efectos durables encolados en esta transacción.
 */
async function devolverASaldoAFavor(s: Solicitud): Promise<CardRefundResult> {
  const out = await withDeadlockRetry(
    async tx => {
      // «primer-sobre» es SIEMPRE el primer candado de su transacción (S2), antes de Orders, Payments, sobres y turno.
      await tomarCandadoPrimerSobreSiHaceFaltaEnTx(tx, s.venueId)
      const d = await decidirDevolucionEnTx(tx, s)
      if (d.replay) return { replay: true as const, id: d.id }
      const clienta = d.saldo! // `decidirDevolucionEnTx` la exige con STORE_CREDIT
      const fila = await tx.onlineOrderCardRefund.create({
        data: {
          venueId: s.venueId,
          chargeId: d.charge.id,
          key: s.idempotencyKey,
          amountCents: s.amountCents,
          reason: s.reason,
          staffId: s.staffId,
          note: s.note,
          requestHash: s.requestHash,
          status: R.RESOLVED,
          toStoreCredit: true,
          feeRefundedCents: 0, // Stripe no devolvió nada: la comisión de la plataforma se queda
          recordedAt: d.ahora,
          nextCheckAt: NEVER_AGAIN,
          // D661 (C3): la reversa del sello es un efecto que ya queda encolado en ESTA transacción (`enqueueRefundPaymentEffectsInTx`);
          // sellada desde que nace, la rama de las selladas del recorrido de Stripe nunca la toma (ni con otra `nextCheckAt`).
          stampReversedAt: d.ahora,
        },
        select: { id: true },
      })
      const { original } = d.cobro
      // Lo que queda del cobro, completo (FULL_REFUND_ONLY): la venta y la propina que quedan, como reparte `issueRefund`.
      const reparto = ajustarRepartoAComponentesRestantes({
        originalSalesCents: toStripeAmount(new Prisma.Decimal(String(original.amount ?? 0))),
        originalTipsCents: toStripeAmount(new Prisma.Decimal(String(original.tipAmount ?? 0))),
        refundedSalesCents: d.cobro.refundedSalesCents,
        refundedTipsCents: d.cobro.refundedTipsCents,
        refundCents: s.amountCents,
        requestedTipCents: 0,
      })
      const tender = { ...(await resolveStoreCreditTenderInTx(tx, s.venueId)), merchantAccountId: null, source: PaymentSource.OTHER }
      const { refundPaymentId, abono } = await writeRefundInTx(tx, {
        originalPaymentId: original.id,
        venueId: s.venueId,
        salesRefundCents: reparto.salesRefundCents,
        tipRefundCents: reparto.tipRefundCents,
        refundedItems: [],
        reason: s.reason,
        note: NOTA_SALDO_A_FAVOR,
        staffId: s.staffId,
        idempotencyKey: `oocr_${fila.id}`,
        tenderCommission: 'NONE',
        // El cobro de Stripe nunca entró a un turno: la devolución tampoco le resta al vivo.
        shift: 'INHERIT_ORIGINAL',
        provenance: 'MANUAL',
        bloqueado: d.cobro,
        aSaldoAFavor: {
          tender,
          customerId: clienta.customerId,
          // Ronda 2 de codex-r3 (Ruling 75): exige el mismo teléfono, así que la ficha se toma ANTES del sobre (Customer → saldo y GiftCard).
          bloquearFicha: true,
          abonar: (t, refundPaymentId, preparado, renglon) =>
            abonarSaldoAFavorEnTx(t, {
              preparado,
              monto: new Prisma.Decimal(renglon.montoCents).div(100),
              staffId: s.staffId,
              origen: { orderId: renglon.orderId, refundPaymentId },
              folio: clienta.folio,
              tipo: 'REEMBOLSO',
              // r1 #6 y r3 #6: el teléfono que manda es el que verificó al pagar, nunca el de la ficha de hoy.
              exigirMismoTelefono: { telefonoVerificado: clienta.telefonoVerificado },
            }),
        },
      })
      await tx.onlineOrderCardRefund.update({ where: { id: fila.id }, data: { refundPaymentId } })
      await enqueueRefundPaymentEffectsInTx(tx, refundPaymentId, original.id)
      const cierre = await cerrarComoDevueltoEnTx(tx, { venueId: s.venueId, orderId: s.orderId, now: d.ahora, staffId: s.staffId })
      // Todo o nada: un saldo abonado sin el pedido cerrado «Devuelto» no se queda (hoy ningún estado lo alcanza).
      if (!cierre.cerrado) {
        throw new ConflictError('El pedido cambió mientras se devolvía. Vuelve a intentarlo; no se aplicó nada.', 'ORDER_STATE_CHANGED')
      }
      return {
        replay: false as const,
        id: fila.id,
        refundPaymentId,
        abono,
        orderNumber: cierre.orderNumber,
        originalPaymentId: original.id,
        ahora: d.ahora,
      }
    },
    { etiqueta: 'devolverASaldoAFavor', ...ORDER_LOCK_WAIT_BUDGET },
  )

  if (out.replay) {
    const row = (await load(out.id))!
    return {
      status: OUTCOME_OF[row.status],
      cardRefundStatus: row.status,
      cardRefundId: row.id,
      refundId: row.refundPaymentId,
      replay: true,
    }
  }
  emitOnlineOrderUpdated({
    venueId: s.venueId,
    orderId: s.orderId,
    orderNumber: out.orderNumber,
    onlineStatus: OnlineOrderStatus.COMPLETED,
    now: out.ahora,
  })
  void logAction({
    staffId: s.staffId,
    venueId: s.venueId,
    action: 'ONLINE_ORDER_REFUNDED_TO_STORE_CREDIT',
    entity: 'OnlineOrderCardRefund',
    entityId: out.id,
    data: {
      orderId: s.orderId,
      amount: pesos(s.amountCents),
      refundPaymentId: out.refundPaymentId,
      giftCardId: out.abono?.giftCardId ?? null,
      newBalance: out.abono?.saldoNuevo.toFixed(2) ?? null,
      reason: s.reason,
    },
  })
  // Como toda devolución (el dueño las busca así): el renglón REFUND, a saldo a favor.
  void logAction({
    staffId: s.staffId,
    venueId: s.venueId,
    action: 'REFUND_CREATED',
    entity: 'Payment',
    entityId: out.refundPaymentId,
    data: {
      amount: s.amountCents / 100, // pesos
      reason: s.reason,
      originalPaymentId: out.originalPaymentId,
      note: s.note,
      refundMethod: 'STORE_CREDIT',
      source: 'ONLINE_ORDERS',
    },
  })
  return { status: 'RECORDED', cardRefundStatus: R.RESOLVED, cardRefundId: out.id, refundId: out.refundPaymentId, replay: false }
}

const filaDeOtroMedio = (i: { venueId: string; orderId: string; cardRefundId: string }) => ({
  id: i.cardRefundId,
  venueId: i.venueId,
  charge: { onlineOrder: { orderId: i.orderId } },
})

/**
 * D668: lo que se le pregunta a Stripe ANTES de pagarle otra vez al cliente por otro medio, fuera de toda transacción. Sólo si la
 * devolución está `REVERSED`: con una devolución hecha por fuera de Avoqado → 409 `EXTERNAL_REFUND_DETECTED`; sin respuesta → 503.
 * `true` si se le preguntó (bajo el candado, una `REVERSED` que no se preguntó no se paga). La usan la resolución y la vista previa del MCP.
 */
export async function revisarStripeAntesDeOtroMedio(i: { venueId: string; orderId: string; cardRefundId: string }): Promise<boolean> {
  const fila = await prisma.onlineOrderCardRefund.findFirst({ where: filaDeOtroMedio(i) })
  if (fila?.status !== R.REVERSED) return false
  const { charge, paymentIntentId } = await chargeOf(fila)
  await exigirSinDevolucionPorFuera(
    { ...charge, paymentIntentId },
    porFuera =>
      `Este cobro ya tiene $${porFuera} devueltos directo en Stripe, por fuera de Avoqado: no le des los $${pesos(fila.amountCents)} otra vez. Revisa en Stripe si al cliente ya le llegó; si ya le llegó, usa «Ya se devolvió en Stripe». Aquí no se pagó ni se registró nada.`,
  )
  return true
}

/** D670: en la reversa, «Ya se devolvió en Stripe» queda como `CREDIT_CARD` (se le devolvió a su tarjeta); hacia afuera, `STRIPE`. */
const CERRADA_EN_STRIPE = PaymentMethod.CREDIT_CARD
/** D670: lo que Stripe ya devolvió por fuera de Avoqado (sólo lo `SUCCEEDED` cuenta) y lo que sigue pendiente, en centavos. */
type Cobertura = { hechasCents: number; pendientesCents: number; stripeRefundIds: string[] }
const coberturaDe = (deFuera: DevolucionDeStripe[]): Cobertura => {
  const hechas = deFuera.filter(r => r.status === 'SUCCEEDED')
  return {
    hechasCents: sumaCents(hechas),
    pendientesCents: sumaCents(deFuera.filter(r => r.status === 'PENDING')),
    stripeRefundIds: hechas.map(r => r.refundId),
  }
}
/** D670: las reversas de ESTE cargo ya cerradas con «Ya se devolvió en Stripe» (salvo `sinLa`). */
const cerradasEnStripe = (i: { venueId: string; chargeId: string; sinLa?: string }) => ({
  venueId: i.venueId,
  resolvedMethod: CERRADA_EN_STRIPE,
  resolvedAt: { not: null },
  cardRefund: { is: { chargeId: i.chargeId } },
  ...(i.sinLa ? { cardRefundId: { not: i.sinLa } } : {}),
})
const usadoEnStripe = async (db: Prisma.TransactionClient, fila: { id: string; venueId: string; chargeId: string }) =>
  (
    await db.onlineOrderCardRefundReversal.aggregate({
      where: cerradasEnStripe({ venueId: fila.venueId, chargeId: fila.chargeId, sinLa: fila.id }),
      _sum: { amountCents: true },
    })
  )._sum.amountCents ?? 0

/**
 * D670: ¿alcanza lo devuelto por fuera de Avoqado, ya HECHO en Stripe y sin usar por otra reversa del cargo, para dar por pagados los
 * `montoCents` de esta? Si no: con lo pendiente alcanzaría → 409 «espera»; si no → 409 con lo que falta. Nunca se paga la diferencia.
 */
function exigirCobertura(montoCents: number, c: Cobertura, usadoCents: number): void {
  const libres = c.hechasCents - usadoCents
  if (libres >= montoCents) return
  const nada = ' Aquí no se registró nada.'
  if (Math.max(0, libres) + c.pendientesCents >= montoCents) {
    throw new ConflictError(
      `La devolución hecha directo en Stripe todavía no termina: cuando Stripe la marque como hecha, vuelve a intentarlo.${nada}`,
      'EXTERNAL_REFUND_PENDING',
    )
  }
  const falta = `faltan $${pesos(montoCents - Math.max(0, libres))} para los $${pesos(montoCents)} de esta devolución.`
  throw new ConflictError(
    c.hechasCents === 0
      ? `Este cobro no tiene devoluciones hechas directo en Stripe: no se puede dar por devuelto así. Devuélvelo en efectivo o por transferencia.${nada}`
      : usadoCents > 0
        ? `En Stripe hay $${pesos(c.hechasCents)} devueltos por fuera de Avoqado y $${pesos(usadoCents)} ya cerraron otra devolución de este cobro: ${falta}${nada}`
        : `En Stripe sólo hay $${pesos(c.hechasCents)} devueltos por fuera de Avoqado: ${falta}${nada}`,
    'EXTERNAL_REFUND_NOT_COVERED',
  )
}

/**
 * D670: la revisión de «Ya se devolvió en Stripe», fuera de toda transacción (la resolución y la vista previa del MCP). Sólo si la
 * devolución está `REVERSED`; `null` si no (bajo el candado, una `REVERSED` sin revisar no se cierra). 409 si no alcanza; 503 si Stripe
 * no contesta.
 */
export async function revisarCoberturaEnStripe(i: { venueId: string; orderId: string; cardRefundId: string }): Promise<Cobertura | null> {
  const fila = await prisma.onlineOrderCardRefund.findFirst({ where: filaDeOtroMedio(i) })
  if (fila?.status !== R.REVERSED) return null
  const { charge, paymentIntentId } = await chargeOf(fila)
  const c = coberturaDe((await leerDevolucionesPorFuera({ ...charge, paymentIntentId })).deFuera)
  exigirCobertura(fila.amountCents, c, await usadoEnStripe(prisma, fila))
  return c
}

/**
 * «Devolver por otro medio» (decisión del founder «a»): sólo una devolución `REVERSED` con su reversa sin resolver; repetir es
 * idempotente por `cardRefundId`. En efectivo, la salida de caja va en la MISMA transacción (r5 #2): sin caja abierta, 409 y no se
 * resuelve nada. El REFUND de Stripe no se toca. Ningún otro camino devuelve en efectivo un cobro de tarjeta.
 * D668: antes, fuera de la transacción, se le pregunta a Stripe (la misma lectura que Ruling 28): si el cargo ya tiene una devolución
 * hecha por fuera de Avoqado, completa o parcial, no se paga ni se registra nada (409 `EXTERNAL_REFUND_DETECTED`; sin respuesta, 503).
 * No se cierra sola: Avoqado no sabe si esa devolución es la de esta reversa. Una repetición no le pregunta a Stripe.
 * D670: `STRIPE` = «Ya se devolvió en Stripe»: la persona lo afirma y Stripe lo comprueba (lo HECHO por fuera, sin usar por otra reversa
 * del cargo, alcanza el monto; la cuenta de lo usado se repite bajo el candado). Sin `PAY_OUT`, sin otro pago, sin mover dinero.
 */
export async function resolveReversedCardRefund(i: {
  venueId: string
  orderId: string
  cardRefundId: string
  method: 'CASH' | 'BANK_TRANSFER' | 'STRIPE'
  staffId: string
  note?: string | null
}): Promise<{ status: 'RESOLVED'; replay: boolean }> {
  if (i.method !== 'CASH' && i.method !== 'BANK_TRANSFER' && i.method !== 'STRIPE') {
    throw new BadRequestError('El método debe ser CASH, BANK_TRANSFER o STRIPE')
  }
  const note = i.note?.trim() || null
  const now = new Date()
  const filaDeLaDevolucion = filaDeOtroMedio(i)
  let preguntadoAStripe: boolean
  let cobertura: Cobertura | null = null
  try {
    if (i.method === 'STRIPE') {
      cobertura = await revisarCoberturaEnStripe(i)
      preguntadoAStripe = cobertura !== null
    } else {
      preguntadoAStripe = await revisarStripeAntesDeOtroMedio(i)
    }
  } catch (error) {
    // Codex r1 #5: otra solicitud la resolvió mientras se le preguntaba a Stripe; eso es una repetición, no «no se aplicó nada».
    const ahora = await prisma.onlineOrderCardRefund.findFirst({ where: filaDeLaDevolucion, select: { status: true } })
    if (ahora?.status === R.RESOLVED) return { status: 'RESOLVED', replay: true }
    throw error
  }
  const out = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: i.venueId, orderId: i.orderId }))) {
      throw new NotFoundError('Pedido no encontrado')
    }
    const row = await tx.onlineOrderCardRefund.findFirst({ where: filaDeLaDevolucion })
    if (!row) throw new NotFoundError('Devolución no encontrada')
    if (row.status === R.RESOLVED) return { replay: true, row }
    const reversa = await tx.onlineOrderCardRefundReversal.findUnique({ where: { cardRefundId: row.id } })
    if (row.status !== R.REVERSED || !reversa || reversa.resolvedAt) {
      throw new ConflictError('Esta devolución no está pendiente de pagarse por otro medio.', 'CARD_REFUND_NOT_REVERSED')
    }
    // D668: se volvió REVERSED después de la lectura de arriba, sin preguntarle a Stripe: no se paga a ciegas.
    if (!preguntadoAStripe) {
      throw new ConflictError('La devolución cambió mientras se resolvía. Intenta de nuevo.', 'CARD_REFUND_CHANGED')
    }
    // D670: otra reversa del cargo pudo cerrarse con la misma devolución de fuera entre la revisión y este candado.
    if (cobertura) exigirCobertura(row.amountCents, cobertura, await usadoEnStripe(tx, row))
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
      data: {
        resolvedMethod: i.method === 'STRIPE' ? CERRADA_EN_STRIPE : i.method,
        resolvedByStaffId: i.staffId,
        resolvedAt: now,
        resolvedNote: note,
        cashDrawerEventId,
      },
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
      action: i.method === 'STRIPE' ? 'ONLINE_ORDER_CARD_REFUND_RESOLVED_IN_STRIPE' : 'ONLINE_ORDER_CARD_REFUND_RESOLVED',
      entity: 'OnlineOrderCardRefund',
      entityId: i.cardRefundId,
      data: {
        orderId: i.orderId,
        method: i.method,
        amount: pesos(out.row.amountCents),
        note,
        cashDrawerEventId: 'cashDrawerEventId' in out ? out.cashDrawerEventId : null,
        ...(cobertura ? { devueltoEnStripe: pesos(cobertura.hechasCents), stripeRefundIds: cobertura.stripeRefundIds } : {}),
      },
    })
  }
  return { status: 'RESOLVED', replay: out.replay }
}

/**
 * D670: Stripe puede tumbar después una devolución `succeeded` (hasta 30 días, `refund.failed`), y la de fuera va a la MISMA tarjeta
 * cuya devolución ya falló. Con cada aviso de una devolución de fuera se relee el cargo: si lo HECHO por fuera ya no alcanza lo cerrado
 * con «Ya se devolvió en Stripe», esas reversas del cargo vuelven a `REVERSED` (todas: las que sigan cubiertas se cierran otra vez con un
 * clic), con bitácora, 🚨 y aviso al negocio. Sin cerradas así no se lee nada. Si Stripe no contesta, truena (el aviso se reintenta).
 */
async function reabrirLoQueStripeYaNoCubre(charge: CargoEnStripe & { orderId: string; orderNumber: string | null }): Promise<void> {
  const cerradas = cerradasEnStripe({ venueId: charge.venueId, chargeId: charge.id })
  const usado =
    (await prisma.onlineOrderCardRefundReversal.aggregate({ where: cerradas, _sum: { amountCents: true } }))._sum.amountCents ?? 0
  if (!usado) return
  const { hechasCents } = coberturaDe((await leerDevolucionesPorFuera(charge)).deFuera)
  if (hechasCents >= usado) return
  const reabiertas = await prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: charge.venueId, orderId: charge.orderId }))) return []
    // ponytail: un cargo trae a lo más un puñado de reversas; tope de 100.
    const filas = await tx.onlineOrderCardRefundReversal.findMany({
      where: cerradas,
      select: { cardRefundId: true, amountCents: true },
      take: 100,
    })
    if (sumaCents(filas) <= hechasCents) return []
    for (const f of filas) {
      const moved = await tx.onlineOrderCardRefund.updateMany({
        where: { id: f.cardRefundId, venueId: charge.venueId, status: R.RESOLVED },
        data: { status: R.REVERSED },
      })
      const reabierta = await tx.onlineOrderCardRefundReversal.updateMany({
        where: { cardRefundId: f.cardRefundId, resolvedMethod: CERRADA_EN_STRIPE },
        data: { resolvedMethod: null, resolvedAt: null, resolvedByStaffId: null, resolvedNote: null },
      })
      if (moved.count !== 1 || reabierta.count !== 1) throw new Error(`la devolución ${f.cardRefundId} cambió mientras se reabría`)
    }
    return filas
  }, ORDER_LOCK_WAIT_BUDGET)
  for (const f of reabiertas) {
    const amount = pesos(f.amountCents)
    logger.error('🚨 [OnlineOrderCardRefund] la devolución hecha directo en Stripe falló: la reversa vuelve a quedar pendiente', {
      cardRefundId: f.cardRefundId,
      venueId: charge.venueId,
      orderId: charge.orderId,
      amount,
    })
    void logAction({
      staffId: null,
      venueId: charge.venueId,
      action: 'ONLINE_ORDER_CARD_REFUND_REOPENED',
      entity: 'OnlineOrderCardRefund',
      entityId: f.cardRefundId,
      data: { orderId: charge.orderId, amount, devueltoEnStripe: pesos(hechasCents), cerradoEnStripe: pesos(usado) },
    })
    void sendVenueNotification(
      charge.venueId,
      {
        type: 'PAYMENT_FAILED',
        title: 'Falló la devolución hecha en Stripe',
        message: `La devolución de $${amount}${charge.orderNumber ? ` del pedido ${charge.orderNumber}` : ''} que se hizo directo en Stripe falló en el banco: se le vuelve a deber a la clienta. Devuélvelo por otro medio desde el pedido.`,
        entityType: 'OnlineOrderCardRefund',
        entityId: f.cardRefundId,
        priority: 'HIGH',
        metadata: { orderId: charge.orderId, cardRefundId: f.cardRefundId },
      },
      ['OWNER', 'ADMIN', 'MANAGER'],
    ).catch(error =>
      logger.error('[OnlineOrderCardRefund] no se pudo avisar al negocio', { cardRefundId: f.cardRefundId, error: errorText(error) }),
    )
  }
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
    status: r.status,
    amount: pesos(r.amountCents),
    reason: r.reason,
    note: r.note,
    stripeRefundId: r.stripeRefundId,
    refundPaymentId: r.refundPaymentId,
    feeRefunded: r.feeRefundedCents == null ? null : pesos(r.feeRefundedCents),
    /** D661 (Task 6): `true` = se devolvió como saldo a favor en el negocio (nace RESOLVED, sin Stripe ni reversa), no a la tarjeta. */
    toStoreCredit: r.toStoreCredit,
    createdAt: r.createdAt.toISOString(),
    /** Sólo con `REVERSED`/`RESOLVED`: el panel ofrece «Devolver por otro medio» mientras `resolvedAt` sea null. */
    reversal: r.reversal
      ? {
          failureReason: r.reversal.failureReason,
          detectedAt: r.reversal.detectedAt.toISOString(),
          // D670: «Ya se devolvió en Stripe» se guarda como CREDIT_CARD; hacia afuera es `STRIPE`, el mismo valor con el que se pide.
          resolvedMethod: r.reversal.resolvedMethod === CERRADA_EN_STRIPE ? ('STRIPE' as const) : r.reversal.resolvedMethod,
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
    select: {
      id: true,
      venueId: true,
      onlineOrderId: true,
      merchantSnapshot: true,
      paymentIntentId: true,
      ecommerceMerchantId: true,
      onlineOrder: { select: { orderId: true, order: { select: { orderNumber: true } } } },
    },
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
  // D670: si con devoluciones de fuera se cerró alguna reversa de este cargo, se relee Stripe (el aviso no se cree).
  if (charge.onlineOrder && charge.paymentIntentId) {
    await reabrirLoQueStripeYaNoCubre({
      ...charge,
      paymentIntentId: charge.paymentIntentId,
      orderId: charge.onlineOrder.orderId,
      orderNumber: charge.onlineOrder.order?.orderNumber ?? null,
    })
  }
}
