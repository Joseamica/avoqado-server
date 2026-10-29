// src/services/online-ordering/card/reconcile.service.ts
/**
 * Fase 2 — el conciliador de cargos con tarjeta (cada minuto): termina lo que un cobro dejó EN DUDA.
 *   - `PENDING_AUTH` vencido: confirma (crea el pedido si sí se apartó; si no, `ABANDONED`). Sin sesión guardada, repite la clave
 *     del último intento con sus mismos parámetros; si Stripe ya no acepta el vencimiento, no hay sesión que pagar → `ABANDONED`.
 *   - `CAPTURING` de más de 60 s (antes puede haber una captura en vuelo): lee el PaymentIntent y cobra, termina o falla.
 *   - `RELEASING`: libera.
 *   - `AUTHORIZED` cuyo pedido ya se cerró por otro camino (rechazado, vencido, cancelado, la caja canceló la cuenta): libera.
 * Cada cargo va en su propio `try`, y TODO cargo leído se toca (`updatedAt`, CAS sobre su estado) para que la siguiente pasada
 * alcance a los de atrás (ruling 4). Stripe siempre fuera de transacciones y con la foto del comercio del cargo.
 */
import { OnlineOrderChargeStatus as S, OnlineOrderStatus, OrderStatus, Prisma, type OnlineOrderCharge } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getProvider } from '@/services/payments/provider-registry'
import { CARD_RECONCILE_BATCH, CARD_STUCK_ALERT_MINUTES } from '../constants'
import { prepMinutes } from '../transitions.service'
import type { ReadCandidates } from '../types'
import { captureCharge, failCapture, finishCapture } from './capture.service'
import { CAPTURED_OUTSIDE, confirmCardAuthorization } from './confirm.service'
import { checkoutParams, expiresAtRejected } from './draft.service'
import { chargeMerchant } from './merchant'
import { releaseCharge } from './release.service'

export interface ReconcileResult {
  scanned: number
  finished: number
  released: number
  abandoned: number
  stuck: number
  errors: number
}

/** Ruling 2: un `CAPTURING` más joven puede tener su captura todavía en vuelo. */
const CAPTURE_IN_FLIGHT_MS = 60_000
/** Ruling 3: un `PENDING_AUTH` vencido cuya confirmación truena este número de pasadas necesita a una persona. */
const CONFIRM_FAILURES_ALERT = 3
/** Stripe guarda una clave idempotente 24 h; con 1 h de margen, después de 23 h su repetición ya no prueba nada. */
const STRIPE_IDEMPOTENCY_SAFE_MS = 23 * 60 * 60_000
/** Ruling 3: `lastError` de un `CAPTURING` que no se arregla solo (Stripe cobró, pero la cuenta no cuadra). */
const NEEDS_HUMAN = new Set(['TOTAL_CHANGED', 'CAPTURED_AMOUNT_MISMATCH'])
const IN_DOUBT: ReadonlySet<S> = new Set([S.CAPTURING, S.RELEASING])
const FINAL: ReadonlySet<S> = new Set([S.CAPTURED, S.CAPTURE_FAILED, S.RELEASED, S.ABANDONED])
/** El pedido sigue vivo: su tarjeta apartada se cobra al aceptar, no se suelta. */
const LIVE_ONLINE: OnlineOrderStatus[] = [
  OnlineOrderStatus.PENDING_ACCEPTANCE,
  OnlineOrderStatus.ACCEPTED,
  OnlineOrderStatus.READY,
  OnlineOrderStatus.COMPLETED,
]

type Row = OnlineOrderCharge & { onlineOrder: { orderId: string } | null }
const order = [{ updatedAt: 'asc' as const }, { id: 'asc' as const }]
const include = { onlineOrder: { select: { orderId: true } } }

async function readCandidates(now: Date, readEntry: ReadCandidates): Promise<Row[]> {
  const page = (where: Prisma.OnlineOrderChargeWhereInput) =>
    readEntry(() => prisma.onlineOrderCharge.findMany({ where, include, orderBy: order, take: CARD_RECONCILE_BATCH }))
  const groups = await Promise.all([
    // Codex r1 C3: el borrador cobrado fuera de Avoqado ya no se reintenta (ni se abandona): lo resuelve una persona.
    page({
      status: S.PENDING_AUTH,
      checkoutExpiresAt: { lte: now },
      OR: [{ lastError: null }, { lastError: { not: CAPTURED_OUTSIDE } }],
    }),
    page({ status: S.CAPTURING, updatedAt: { lte: new Date(now.getTime() - CAPTURE_IN_FLIGHT_MS) } }),
    page({ status: S.RELEASING }),
    page({
      status: S.AUTHORIZED,
      OR: [
        { onlineOrderId: null },
        { onlineOrder: { status: { notIn: LIVE_ONLINE } } },
        // La caja canceló la cuenta y la sincronización R2 todavía no cierra el pedido en línea.
        { onlineOrder: { order: { status: { in: [OrderStatus.CANCELLED, OrderStatus.DELETED] } } } },
      ],
    }),
  ])
  return groups.flat()
}

/** `PENDING_AUTH` sin sesión guardada: la MISMA clave y los MISMOS parámetros del último intento. */
async function recoverCheckout(charge: Row, now: Date): Promise<'GOT' | 'ABANDONED' | 'NEEDS_HUMAN'> {
  const merchant = chargeMerchant(charge)
  try {
    const session = await getProvider(merchant).createAuthorizationCheckout(merchant, checkoutParams(charge))
    await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: S.PENDING_AUTH, checkoutSessionId: null },
      data: { checkoutSessionId: session.id, checkoutUrl: session.url },
    })
    return 'GOT'
  } catch (error: any) {
    // La clave nunca se ejecutó y su vencimiento ya pasó (o la sesión no existe): no hay nada que el cliente pueda pagar.
    if (!expiresAtRejected(error) && error?.code !== 'resource_missing') throw error
    // Ese rechazo sólo prueba «la clave nunca se ejecutó» dentro de la ventana de idempotencia de Stripe (24 h). Pasada esa ventana
    // Stripe ya olvidó la clave: la sesión pudo existir y apartar la tarjeta. No se abandona a ciegas: lo ve una persona.
    if (now.getTime() - charge.createdAt.getTime() > STRIPE_IDEMPOTENCY_SAFE_MS) {
      await alert(charge, now, 'CHECKOUT_REPLAY_OUTSIDE_IDEMPOTENCY_WINDOW')
      return 'NEEDS_HUMAN'
    }
    await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: S.PENDING_AUTH, checkoutSessionId: null },
      data: { status: S.ABANDONED },
    })
    return 'ABANDONED'
  }
}

async function processCapturing(charge: Row, now: Date): Promise<void> {
  if (!charge.onlineOrder || !charge.paymentIntentId) throw new Error('cargo CAPTURING sin pedido o sin PaymentIntent')
  const merchant = chargeMerchant(charge)
  const state = await getProvider(merchant).getAuthorization(merchant, { paymentIntentId: charge.paymentIntentId })
  const meta = { staffId: null, estimatedMinutes: await prepMinutes(charge.venueId), now }
  if (state.piStatus === 'succeeded') await finishCapture(charge.id, state, meta)
  else if (state.piStatus === 'requires_capture') await captureCharge(charge, charge.onlineOrder.orderId, meta)
  else if (state.piStatus === 'canceled' || state.piStatus === 'requires_payment_method')
    await failCapture(charge.id, { staffId: null, now })
}

async function processOne(charge: Row, now: Date): Promise<void> {
  switch (charge.status) {
    case S.PENDING_AUTH:
      if (!charge.checkoutSessionId && (await recoverCheckout(charge, now)) !== 'GOT') return
      await confirmCardAuthorization(charge.id, now)
      return
    case S.CAPTURING:
      return processCapturing(charge, now)
    case S.RELEASING:
      await releaseCharge(charge.id)
      return
    case S.AUTHORIZED: {
      const won = await prisma.onlineOrderCharge.updateMany({
        where: { id: charge.id, status: S.AUTHORIZED },
        data: { status: S.RELEASING },
      })
      if (won.count === 1) await releaseCharge(charge.id)
      return
    }
  }
}

/** M2: la bitácora dice QUÉ se atoró: la confirmación (borrador), la captura (incluye TOTAL_CHANGED) o la liberación. */
const STUCK_ACTION: Partial<Record<S, string>> = {
  [S.PENDING_AUTH]: 'ONLINE_ORDER_CARD_CONFIRM_STUCK',
  [S.CAPTURING]: 'ONLINE_ORDER_CARD_CAPTURE_STUCK',
  [S.RELEASING]: 'ONLINE_ORDER_CARD_RELEASE_STUCK',
}

async function alert(charge: Row, now: Date, why: string): Promise<void> {
  const won = await prisma.onlineOrderCharge.updateMany({
    where: { id: charge.id, status: charge.status, stuckAlertedAt: null },
    data: { stuckAlertedAt: now },
  })
  if (won.count !== 1) return
  logger.error('🚨 [OnlineOrderCard] cargo atorado', { chargeId: charge.id, status: charge.status, venueId: charge.venueId, why })
  await logAction({
    venueId: charge.venueId,
    action: STUCK_ACTION[charge.status] ?? 'ONLINE_ORDER_CARD_RELEASE_STUCK',
    entity: 'OnlineOrderCharge',
    entityId: charge.id,
    data: { chargeId: charge.id, status: charge.status, why, amount: new Prisma.Decimal(charge.amount).toFixed(2) },
  })
}

type Outcome = 'finished' | 'released' | 'abandoned' | 'stuck'

/** Después de procesar (o de tronar): toca la fila si sigue igual, alerta lo que toca, borra la marca al terminar. */
async function settle(charge: Row, now: Date, failure: string | null): Promise<Outcome> {
  const after = await prisma.onlineOrderCharge.findUnique({
    where: { id: charge.id },
    select: { status: true, lastError: true, attempts: true, stuckAlertedAt: true, inDoubtSince: true },
  })
  if (!after) return 'stuck'
  if (after.status !== charge.status) {
    if (FINAL.has(after.status) && (after.stuckAlertedAt || after.inDoubtSince)) {
      await prisma.onlineOrderCharge.updateMany({
        where: { id: charge.id, status: after.status },
        data: { stuckAlertedAt: null, inDoubtSince: null },
      })
    }
    if (after.status === S.RELEASED) return 'released'
    if (after.status === S.ABANDONED) return 'abandoned'
    return after.status === S.RELEASING ? 'stuck' : 'finished'
  }

  // Sigue en el mismo estado: se toca para rotar el lote; en duda, se anota desde cuándo.
  const inDoubtSince = IN_DOUBT.has(charge.status) ? (after.inDoubtSince ?? now) : null
  const countFailure = failure != null && charge.status === S.PENDING_AUTH
  await prisma.onlineOrderCharge.updateMany({
    where: { id: charge.id, status: charge.status },
    data: {
      updatedAt: now,
      ...(inDoubtSince ? { inDoubtSince } : {}),
      ...(countFailure ? { attempts: { increment: 1 }, lastError: failure.slice(0, 500) } : {}),
    },
  })

  if (charge.status === S.CAPTURING && after.lastError && NEEDS_HUMAN.has(after.lastError)) {
    await alert(charge, now, after.lastError)
  } else if (inDoubtSince && now.getTime() - inDoubtSince.getTime() >= CARD_STUCK_ALERT_MINUTES * 60_000) {
    await alert(charge, now, after.lastError ?? 'SIN_DESENLACE')
  } else if (countFailure && after.attempts + 1 >= CONFIRM_FAILURES_ALERT) {
    await alert(charge, now, `CONFIRM_FAILED: ${failure}`)
  }
  return 'stuck'
}

export async function reconcileCardCharges(now: Date, readEntry: ReadCandidates): Promise<ReconcileResult> {
  const result: ReconcileResult = { scanned: 0, finished: 0, released: 0, abandoned: 0, stuck: 0, errors: 0 }
  const rows = await readCandidates(now, readEntry)
  result.scanned = rows.length
  for (const charge of rows) {
    let failure: string | null = null
    try {
      await processOne(charge, now)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      result.errors += 1
      logger.error('[OnlineOrderCard] el conciliador no pudo con un cargo (sigue con los demás)', {
        chargeId: charge.id,
        status: charge.status,
        venueId: charge.venueId,
        error: failure,
      })
    }
    try {
      const outcome = await settle(charge, now, failure)
      if (failure == null) result[outcome] += 1
    } catch (error) {
      logger.error('[OnlineOrderCard] el conciliador no pudo anotar un cargo', { chargeId: charge.id, error })
    }
  }
  return result
}
