// src/services/online-ordering/card/reconcile.service.ts
/**
 * Fase 2 — el conciliador de cargos con tarjeta (cada minuto): termina lo que un cobro dejó EN DUDA.
 *   - `PENDING_AUTH` vencido: confirma (crea el pedido si sí se apartó; si no, `ABANDONED`). Sin sesión guardada, repite la clave
 *     del último intento con sus mismos parámetros; si Stripe ya no acepta el vencimiento, no hay sesión que pagar → `ABANDONED`.
 *   - D661 (Ruling 10): `PENDING_AUTH` de «Nadie» con sesión y más de 2 min, aunque su página siga viva: confirma a tiempo la
 *     autorización que nadie avisó (sin aviso de Stripe ni pestaña), o la libera si ya pasó su plazo. D661 (Ruling 74): los que cierran
 *     su franja en los próximos 10 min, sin esperar esos 2 min y antes que los demás (el plazo más temprano primero).
 *   - `CAPTURING` de más de 60 s (antes puede haber una captura en vuelo): lee el PaymentIntent y cobra, termina o falla. D661 (r5 #1):
 *     uno de «Nadie» pasada su gracia ya no se cobra: se suelta y se cierra con el desenlace de Stripe. D661 (C, Ruling 52): tampoco en
 *     sus últimos 90 s (un reenvío del SDK caería después de la gracia).
 *   - `RELEASING`: libera. Es el ÚNICO reintento de una liberación que nadie espera (3B: la lectura de la caja no la espera).
 *   - `AUTHORIZED` cuyo pedido ya se cerró por otro camino (rechazado, vencido, cancelado, la caja canceló la cuenta): libera.
 * Cada cargo va en su propio `try`, y TODO cargo procesado se toca (`updatedAt`, CAS sobre su estado) para que la siguiente pasada
 * alcance a los de atrás (ruling 4). Stripe siempre fuera de transacciones y con la foto del comercio del cargo.
 * D661 (3C): la hora de la pasada sólo ELIGE candidatos; lo que se decide bajo un candado y lo que se escribe usa el reloj real.
 * D661 (A2): el orden de la pasada es el dinero en duda primero (`CAPTURING`, `RELEASING`), luego la visita temprana de «Nadie» con su
 * propio presupuesto (a lo más `NADIE_EARLY_CONCURRENCY` a la vez y nada nuevo después de `NADIE_EARLY_BUDGET_MS`; lo que no alcanza
 * espera al siguiente minuto, el menos reciente primero) y al final lo demás. Si la pasada sigue corriendo en el siguiente minuto, el job
 * corre sólo la visita temprana (`visitEarlyNadieDrafts`): una pasada lenta no deja vencer una autorización que llegó a tiempo.
 * D661 (B, Rulings 42 y 51): la visita temprana lee su lista al EMPEZAR (también dentro de la pasada) y cada llamada suya a Stripe (la
 * lectura, y la liberación con su relectura) espera a lo más `LIMITES_TEMPRANOS` y sin reintentos del SDK: cinco llamadas colgadas ya
 * no retienen el carril minutos. D661 (Ruling 73): TODA llamada a Stripe del conciliador lleva además nuestro plazo duro (la de la visita
 * temprana, 15 s; la del reintento de «Nadie», 45 s; las demás de la pasada, 120 s): una respuesta cuyo cuerpo nunca termina ya no
 * retiene el carril ni la pasada.
 */
import { OnlineOrderChargeStatus as S, OnlineOrderStatus, OrderStatus, Prisma, type OnlineOrderCharge } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getProvider } from '@/services/payments/provider-registry'
import type { AuthorizationState, ProviderRequestLimits } from '@/services/payments/providers/provider.interface'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import {
  ACCEPT_TIMEOUT_MINUTES,
  CARD_RECONCILE_BATCH,
  CARD_STUCK_ALERT_MINUTES,
  NOT_CAPTURED_OUTSIDE,
  PLAZO_DE_LA_PASADA,
  SIN_TELEFONO_NADIE,
  cargoDeNadie,
} from '../constants'
import { prepMinutes } from '../transitions.service'
import type { ReadCandidates } from '../types'
import { GraceEndedBeforeDispatch, captureCharge, failCapture, finishCapture } from './capture.service'
import { confirmCardAuthorization } from './confirm.service'
import { checkoutParams, expiresAtRejected } from './draft.service'
import { chargeMerchant } from './merchant'
import { releaseCharge, voidOrReadOutcome } from './release.service'

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
/** D661 (r5 #1): un `CAPTURING` de «Nadie» se vuelve a cobrar hasta `acceptDeadlineAt` + esta gracia; después sólo se concilia. */
const NADIE_CAPTURE_GRACE_MS = 5 * 60_000
/**
 * D661 (C, Ruling 52): …y el último reintento sale con al menos esto de gracia por delante: aunque no lleva reintentos del SDK, éste
 * todavía reenvía una vez tras una conexión cerrada, hasta ~80.5 s después del envío. Así cualquier reenvío llega dentro de la gracia.
 */
const NADIE_RETRY_MARGIN_MS = 90_000
/** D661 (Ruling 10): edad desde la que se visita un borrador de «Nadie» con su página viva (antes, la clienta apenas está pagando). */
const NADIE_EARLY_VISIT_MS = 2 * 60_000
/** D661 (Ruling 74): …salvo que su plazo pueda caer en esta ventana: entonces no espera esa edad. */
const NADIE_URGENT_WINDOW_MS = 10 * 60_000
/** D661 (A2): borradores de «Nadie» que la visita temprana lee a la vez (cada uno bajo sus propios candados; son independientes)… */
const NADIE_EARLY_CONCURRENCY = 5
/** …y desde cuándo ya no empieza otro: lo que falte espera al siguiente minuto. Con lecturas lentas de T s, la visita dura < este + T. */
const NADIE_EARLY_BUDGET_MS = 30_000
/**
 * D661 (B, Rulings 42 y 51): cada llamada a Stripe de la visita temprana (la lectura del borrador y, si no se vuelve pedido, la
 * cancelación y su relectura): 10 s y sin reintentos del SDK (el cliente del proveedor espera 80 s por intento y reintenta dos veces).
 * La lectura que no contesta espera a la siguiente visita (≤ 1 min); la liberación que no contesta deja el cargo `RELEASING` para la
 * siguiente pasada, con la misma clave. Ojo: tras una conexión cerrada en el primer envío el SDK todavía reenvía una vez (peor caso
 * ~20.5 s por llamada). D661 (Ruling 73): y nuestro plazo duro, 10 + 5 s: una respuesta cuyo cuerpo nunca termina ya no retiene el carril
 * (`earlyLaneBusy`); el cargo sigue en su estado y la siguiente visita repite con la misma clave.
 */
const LIMITES_TEMPRANOS: ProviderRequestLimits = { timeoutMs: 10_000, maxNetworkRetries: 0, plazoMs: 15_000 }
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

const page = (readEntry: ReadCandidates, where: Prisma.OnlineOrderChargeWhereInput): Promise<Row[]> =>
  readEntry(() => prisma.onlineOrderCharge.findMany({ where, include, orderBy: order, take: CARD_RECONCILE_BATCH }))

/**
 * Ruling 10: los de «Nadie» con la página viva (los vencidos van con lo demás). Sin sesión guardada nadie pudo pagar todavía: no se
 * visitan (así cada visita es UNA lectura de su sesión en Stripe). D661 (addendum r3): la edad se mide con la hora del carril (`reloj`)
 * y la página viva desde el INICIO de la pasada (`inicio`): los vencidos se leyeron al empezar (`≤ inicio`), así que un borrador cuya
 * página vence mientras se atiende el dinero en duda ya no se queda sin grupo hasta la siguiente pasada.
 */
const earlyNadieWhere = (reloj: Date, inicio: Date): Prisma.OnlineOrderChargeWhereInput => ({
  status: S.PENDING_AUTH,
  customerPhone: SIN_TELEFONO_NADIE,
  checkoutSessionId: { not: null },
  checkoutExpiresAt: { gt: inicio },
  createdAt: { lte: new Date(reloj.getTime() - NADIE_EARLY_VISIT_MS) },
  // Codex r1 C3: el borrador cobrado fuera de Avoqado ya no se reintenta (ni se abandona): lo resuelve una persona.
  ...NOT_CAPTURED_OUTSIDE,
})

/**
 * D661 (Ruling 74): los de «Nadie» con la página viva cuyo plazo puede caer en los próximos 10 min se visitan SIN esperar sus 2 min de
 * edad. El plazo de su pedido es el cierre de su franja o los 10 min del apartado, lo que llegue primero (Ruling 10); los 10 min corren
 * desde que Stripe autoriza (nunca antes de nacer el borrador), así que esos 2 min sólo pueden costar el CIERRE: cierre en (reloj,
 * reloj + 10 min]. El cierre se guarda con `toISOString` (siempre la misma forma), que se compara como texto en su orden.
 */
const urgentNadieWhere = (reloj: Date, inicio: Date): Prisma.OnlineOrderChargeWhereInput => ({
  status: S.PENDING_AUTH,
  customerPhone: SIN_TELEFONO_NADIE,
  checkoutSessionId: { not: null },
  checkoutExpiresAt: { gt: inicio },
  AND: [
    { request: { path: ['cierreDeFranja'], gt: reloj.toISOString() } },
    { request: { path: ['cierreDeFranja'], lte: new Date(reloj.getTime() + NADIE_URGENT_WINDOW_MS).toISOString() } },
  ],
  ...NOT_CAPTURED_OUTSIDE,
})

/** El plazo más temprano que puede tener su pedido (Ruling 10): min(cierre de su franja, nació + 10 min). */
const plazoMasTemprano = (c: Row): number => {
  const diezMin = c.createdAt.getTime() + ACCEPT_TIMEOUT_MINUTES * 60_000
  const cierre = (c.request as { cierreDeFranja?: string | null } | null)?.cierreDeFranja
  return cierre ? Math.min(Date.parse(cierre), diezMin) : diezMin
}

/**
 * Ruling 74: los urgentes, el plazo más temprano primero (y por id). ponytail: la base los da por `createdAt` y el orden por plazo es en
 * memoria: con más de 50 urgentes a la vez entran los 50 más viejos; si un día pasa, ordenar en SQL por LEAST(cierre, createdAt + 10 min).
 */
const urgentes = async (readEntry: ReadCandidates, reloj: Date, inicio: Date): Promise<Row[]> =>
  (
    await readEntry(() =>
      prisma.onlineOrderCharge.findMany({
        where: urgentNadieWhere(reloj, inicio),
        include,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: CARD_RECONCILE_BATCH,
      }),
    )
  ).sort((a, b) => plazoMasTemprano(a) - plazoMasTemprano(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * Cada grupo con su tope y su orden de siempre; D661 (A2): separados por cómo se procesan. D661 (B, Ruling 42): sin los tempranos: la
 * visita temprana los lee al empezar (`earlyLane`).
 */
async function readCandidates(now: Date, readEntry: ReadCandidates): Promise<{ inDoubt: Row[]; rest: Row[] }> {
  const [expired, capturing, releasing, authorized] = await Promise.all([
    page(readEntry, { status: S.PENDING_AUTH, checkoutExpiresAt: { lte: now }, ...NOT_CAPTURED_OUTSIDE }),
    page(readEntry, { status: S.CAPTURING, updatedAt: { lte: new Date(now.getTime() - CAPTURE_IN_FLIGHT_MS) } }),
    page(readEntry, { status: S.RELEASING }),
    page(readEntry, {
      status: S.AUTHORIZED,
      OR: [
        { onlineOrderId: null },
        { onlineOrder: { status: { notIn: LIVE_ONLINE } } },
        // La caja canceló la cuenta y la sincronización R2 todavía no cierra el pedido en línea.
        { onlineOrder: { order: { status: { in: [OrderStatus.CANCELLED, OrderStatus.DELETED] } } } },
      ],
    }),
  ])
  return { inDoubt: [...capturing, ...releasing], rest: [...expired, ...authorized] }
}

/** `PENDING_AUTH` sin sesión guardada: la MISMA clave y los MISMOS parámetros del último intento. */
async function recoverCheckout(charge: Row, now: Date): Promise<'GOT' | 'ABANDONED' | 'NEEDS_HUMAN'> {
  const merchant = chargeMerchant(charge)
  try {
    const session = await getProvider(merchant).createAuthorizationCheckout(merchant, checkoutParams(charge), PLAZO_DE_LA_PASADA)
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

/**
 * D661 (r5 #1): ¿se vuelve a mandar la captura? «Mi equipo», siempre, como hoy. «Nadie» (la marca del cargo), sólo hasta
 * `acceptDeadlineAt` + la gracia − `NADIE_RETRY_MARGIN_MS` (C, Ruling 52), decidido bajo el candado de la orden con el reloj real (la hora
 * de la pasada puede ser vieja) y con el cargo todavía `CAPTURING` (si otra escritura ya terminó el cobro, no hay nada que hacer); después
 * se suelta. D661 (A1): con `CAPTURE` va ese límite (`captureBefore`), que `captureCharge` vuelve a revisar justo antes de Stripe (el
 * commit o una pausa pueden cruzarlo).
 */
async function captureRetryStep(
  charge: Row,
  orderId: string,
): Promise<{ step: 'CAPTURE' | 'RELEASE' | 'NOTHING'; captureBefore?: number }> {
  if (!cargoDeNadie(charge)) return { step: 'CAPTURE' }
  return prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId: charge.venueId, orderId }))) return { step: 'NOTHING' as const }
    const row = await tx.onlineOrder.findFirst({
      where: { orderId, venueId: charge.venueId },
      select: { acceptDeadlineAt: true, charge: { select: { status: true } } },
    })
    if (!row || row.charge?.status !== S.CAPTURING) return { step: 'NOTHING' as const }
    const captureBefore = row.acceptDeadlineAt.getTime() + NADIE_CAPTURE_GRACE_MS - NADIE_RETRY_MARGIN_MS
    return Date.now() < captureBefore ? { step: 'CAPTURE' as const, captureBefore } : { step: 'RELEASE' as const }
  }, ORDER_LOCK_WAIT_BUDGET)
}

/**
 * D661 (r5 #1, r6 #1): pasó la gracia y Stripe sigue con la tarjeta apartada: ya no se cobra; se suelta, y el pedido se cierra SÓLO
 * con el desenlace de Stripe. Nada se guarda antes de Stripe: la decisión sale del plazo (que no cambia), así que tras una caída la
 * siguiente pasada relee a Stripe y llega sola al mismo desenlace. El cargo sigue `CAPTURING` mientras tanto: si una captura anterior
 * seguía en vuelo y ganó, es NUESTRA y se anota como cualquier cobro (un pago, pedido aceptado, comanda pendiente), nunca como captura
 * externa. Si Stripe la soltó, el cierre es el del cobro fallido (rechazo + cargo, una transacción; sus canjes regresan).
 */
async function releaseCaptureAfterGrace(charge: Row, orderId: string, meta: { staffId: null; estimatedMinutes: number }): Promise<void> {
  let state: AuthorizationState
  try {
    state = await voidOrReadOutcome(charge, `online-order:${orderId}:release`, PLAZO_DE_LA_PASADA)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    await prisma.onlineOrderCharge.updateMany({ where: { id: charge.id, status: S.CAPTURING }, data: { lastError: why.slice(0, 500) } })
    logger.warn('⚠️ [OnlineOrderCard] pasó la gracia y Stripe no dijo si soltó la tarjeta: sigue CAPTURING para la siguiente pasada', {
      chargeId: charge.id,
      orderId,
      why,
    })
    return
  }
  if (state.piStatus === 'succeeded') await finishCapture(charge.id, state, meta)
  else await failCapture(charge.id, { staffId: null, reason: 'RELEASED_AFTER_GRACE' }) // A4: no fue la tarjeta
}

async function processCapturing(charge: Row): Promise<void> {
  if (!charge.onlineOrder || !charge.paymentIntentId) throw new Error('cargo CAPTURING sin pedido o sin PaymentIntent')
  const orderId = charge.onlineOrder.orderId
  const merchant = chargeMerchant(charge)
  const state = await getProvider(merchant).getAuthorization(merchant, { paymentIntentId: charge.paymentIntentId }, PLAZO_DE_LA_PASADA)
  // 3C: sin hora fija: `capturedAt`, `acceptedAt` y el rechazo llevan la hora de la escritura, leída bajo el candado de la orden.
  const meta = { staffId: null, estimatedMinutes: await prepMinutes(charge.venueId) }
  if (state.piStatus === 'succeeded') await finishCapture(charge.id, state, meta)
  else if (state.piStatus === 'canceled' || state.piStatus === 'requires_payment_method') {
    // M1 (ronda codex-r2): un «Nadie» ya sin tiempo de reintento que Stripe dice anulado lo soltó Avoqado (una liberación cuya respuesta
    // se perdió): se cierra con ese motivo, decidido con la MISMA regla que libera. Con tiempo todavía o en «Mi equipo», como hoy.
    const trasLaGracia = state.piStatus === 'canceled' && (await captureRetryStep(charge, orderId)).step === 'RELEASE'
    await failCapture(charge.id, { staffId: null, ...(trasLaGracia ? { reason: 'RELEASED_AFTER_GRACE' as const } : {}) })
  } else if (state.piStatus === 'requires_capture') {
    const { step, captureBefore } = await captureRetryStep(charge, orderId)
    if (step === 'RELEASE') await releaseCaptureAfterGrace(charge, orderId, meta)
    else if (step === 'CAPTURE') {
      try {
        // Ruling 73: el de «Mi equipo» (sin `captureBefore`) con sólo el plazo duro; el de «Nadie», con `UN_SOLO_ENVIO` (su propio plazo).
        await captureCharge(charge, orderId, { ...meta, captureBefore, limites: PLAZO_DE_LA_PASADA })
      } catch (error) {
        // A1: la gracia venció entre la decisión y la llamada: no se mandó nada; se sigue el camino de liberar.
        if (!(error instanceof GraceEndedBeforeDispatch)) throw error
        await releaseCaptureAfterGrace(charge, orderId, meta)
      }
    }
  }
}

/**
 * `limites`: los de cada llamada a Stripe de un borrador de la visita temprana (Rulings 42, 51 y 73); en la pasada principal, sólo el
 * plazo duro (Ruling 73).
 */
async function processOne(charge: Row, now: Date, limites: ProviderRequestLimits = PLAZO_DE_LA_PASADA): Promise<void> {
  switch (charge.status) {
    case S.PENDING_AUTH:
      if (!charge.checkoutSessionId && (await recoverCheckout(charge, now)) !== 'GOT') return
      // 3C: sin la hora de la pasada: el plazo de «Nadie» se comprueba bajo el candado de admisión con el reloj real.
      await confirmCardAuthorization(charge.id, undefined, limites)
      return
    case S.CAPTURING:
      return processCapturing(charge)
    case S.RELEASING:
      await releaseCharge(charge.id, limites)
      return
    case S.AUTHORIZED: {
      const won = await prisma.onlineOrderCharge.updateMany({
        where: { id: charge.id, status: S.AUTHORIZED },
        data: { status: S.RELEASING },
      })
      if (won.count === 1) await releaseCharge(charge.id, limites)
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
  // D661 (A3): un borrador visitado antes de vencer su página sólo espera a la clienta: sus tropiezos con Stripe no cuentan para la alerta.
  const countFailure = failure != null && charge.status === S.PENDING_AUTH && charge.checkoutExpiresAt <= now
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

const emptyResult = (): ReconcileResult => ({ scanned: 0, finished: 0, released: 0, abandoned: 0, stuck: 0, errors: 0 })

/** Un cargo, en su propio `try`: procesarlo, anotarlo y contarlo. */
async function handle(charge: Row, now: Date, result: ReconcileResult, limites?: ProviderRequestLimits): Promise<void> {
  result.scanned += 1
  let failure: string | null = null
  try {
    await processOne(charge, now, limites)
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

// ponytail: candado en memoria (una sola instancia, como el `isRunning` del job); con 2 instancias, un advisory lock por visita.
let earlyLaneBusy = false

/**
 * D661 (A2): la visita temprana, una a la vez en el proceso. Toma los borradores en su orden (el menos reciente primero) con
 * `NADIE_EARLY_CONCURRENCY` trabajadores y no empieza ninguno después de `NADIE_EARLY_BUDGET_MS`: los que no alcanzó no se tocan y
 * quedan primero para la siguiente. D661 (B, Rulings 42 y 51): lee su lista al EMPEZAR, con `reloj` (la hora a la que empieza), y cada
 * llamada a Stripe va con `LIMITES_TEMPRANOS`. `inicio` (addendum r3): el inicio de la pasada que lo corre; la visita sola, `reloj`.
 */
async function earlyLane(readEntry: ReadCandidates, reloj: Date, result: ReconcileResult, inicio: Date = reloj): Promise<void> {
  if (earlyLaneBusy) return
  earlyLaneBusy = true
  try {
    // Ruling 74: primero los de plazo cerca (sin el filtro de edad); después los de siempre, sin repetir.
    const [primero, deSiempre] = await Promise.all([urgentes(readEntry, reloj, inicio), page(readEntry, earlyNadieWhere(reloj, inicio))])
    const ya = new Set(primero.map(c => c.id))
    const pending = [...primero, ...deSiempre.filter(c => !ya.has(c.id))]
    const stopAt = Date.now() + NADIE_EARLY_BUDGET_MS
    let next = 0
    const worker = async () => {
      while (next < pending.length && Date.now() < stopAt) await handle(pending[next++], reloj, result, LIMITES_TEMPRANOS)
    }
    await Promise.all(Array.from({ length: NADIE_EARLY_CONCURRENCY }, worker))
  } finally {
    earlyLaneBusy = false
  }
}

export async function reconcileCardCharges(now: Date, readEntry: ReadCandidates): Promise<ReconcileResult> {
  const result = emptyResult()
  const inicio = Date.now()
  const { inDoubt, rest } = await readCandidates(now, readEntry)
  for (const charge of inDoubt) await handle(charge, now, result) // A2: el dinero en duda, primero
  // D661 (B, Ruling 42): la visita temprana lee su lista al entrar al carril, con la hora de la pasada adelantada lo que ya tardó (en
  // producción, la hora real): un borrador que cumplió sus 2 min mientras se atendía el dinero en duda se visita en esta pasada. Addendum
  // r3: su página viva se mide desde `now` (el inicio), la misma hora con que se leyeron los vencidos.
  await earlyLane(readEntry, new Date(now.getTime() + (Date.now() - inicio)), result, now)
  for (const charge of rest) await handle(charge, now, result)
  return result
}

/** D661 (A2): sólo la visita temprana; el job la corre en el minuto en que la pasada anterior todavía no termina. */
export async function visitEarlyNadieDrafts(now: Date, readEntry: ReadCandidates): Promise<ReconcileResult> {
  const result = emptyResult()
  await earlyLane(readEntry, now, result)
  return result
}
