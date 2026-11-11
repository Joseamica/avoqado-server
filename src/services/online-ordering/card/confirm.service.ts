// src/services/online-ordering/card/confirm.service.ts
/**
 * Fase 2 — la tarjeta quedó apartada: el borrador (`OnlineOrderCharge`) se vuelve pedido (`Order` + `OnlineOrder`) con los
 * precios congelados del borrador. Idempotente: la llaman el aviso de Stripe, la página de seguimiento y el conciliador; el CAS
 * `PENDING_AUTH → AUTHORIZED` decide al único ganador. Nunca queda una tarjeta apartada sin pedido ni liberación (Codex r2 #5).
 */
import { OnlineOrderChargeStatus, OnlineOrderPaymentMode, Prisma, type OnlineOrderCharge } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getProvider } from '@/services/payments/provider-registry'
import type { AuthorizationState } from '@/services/payments/providers/provider.interface'
import { fromStripeAmount, toStripeAmount } from '@/services/payments/providers/money'
import { ACCEPT_TIMEOUT_MINUTES } from '../constants'
import { emitOnlineOrderCreated, fromQuoteSnapshot, lockAdmission, pickOrderNumber, writeOnlineOrderInTx } from '../order.service'
import { BENEFIT_UNAVAILABLE, simularBeneficios, type BeneficioElegido } from '../beneficios.service'
import { despertarPasesTrasCommit } from '../cortesiaDeFolio'
import type { CardDraftRequest } from './draft.service'
import { chargeMerchant } from './merchant'
import { CAPTURED_OUTSIDE, releaseCharge } from './release.service'

export type ConfirmOutcome = 'CREATED' | 'ALREADY' | 'NOT_YET' | 'ABANDONED' | 'RELEASED_LATE' | 'CAPTURED_OUTSIDE'

/** Codex r1 C3: `lastError` de un borrador cuyo PaymentIntent ya se cobró fuera de Avoqado (lo ve una persona; nadie lo reintenta). */
export { CAPTURED_OUTSIDE }

/** S11 (R4): la acción de bitácora del cargo con el motivo de NEGOCIO de su liberación y el precio nuevo (lo lee el seguimiento). */
export const PRECIO_CAMBIO_AL_CONFIRMAR = 'ONLINE_ORDER_CARD_PRICE_CHANGED'

/** S11 (R2', R4'): por qué un apartado con beneficios no se volvió pedido, y el precio nuevo que la tienda vuelve a autorizar. */
interface PrecioCambiado {
  motivo: 'BENEFIT_GONE' | 'PRICE_CHANGED'
  cual: BeneficioElegido | null
  totalEstricto: Prisma.Decimal | null
  descartados: BeneficioElegido[]
}

/** R2': el total estricto del folio no es lo autorizado; viaja como error para revertir el intento entero, con el total de la cuenta. */
class TotalDistintoDelAutorizado extends Error {
  constructor(readonly total: Prisma.Decimal) {
    super('el total estricto no es lo autorizado')
  }
}

/**
 * Apartado que no puede volverse pedido (monto distinto, o la llave ya tiene cuenta): se libera. CAS a `RELEASING` primero (un
 * solo liberador); si Stripe falla, el cargo queda `RELEASING` y el conciliador lo retoma.
 * S11 (R4): con un motivo de negocio (`precio`), se guarda en la bitácora del cargo en la MISMA transacción del CAS: la liberación
 * (`releaseCharge`, que limpia `lastError`) y la conciliación no lo tocan.
 */
async function releaseLate(
  charge: OnlineOrderCharge,
  auth: AuthorizationState,
  why: string,
  precio?: PrecioCambiado,
): Promise<ConfirmOutcome> {
  const won = await prisma.$transaction(async tx => {
    const cas = await tx.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
      // Sale de PENDING_AUTH: un episodio nuevo para la alerta del conciliador.
      data: { status: OnlineOrderChargeStatus.RELEASING, paymentIntentId: auth.paymentIntentId, lastError: why, stuckAlertedAt: null },
    })
    if (cas.count === 1 && precio) {
      await tx.activityLog.create({
        data: {
          venueId: charge.venueId,
          action: PRECIO_CAMBIO_AL_CONFIRMAR,
          entity: 'OnlineOrderCharge',
          entityId: charge.id,
          data: {
            motivo: precio.motivo,
            cual: precio.cual,
            totalEstricto: precio.totalEstricto?.toFixed(2) ?? null,
            descartados: precio.descartados,
            amount: new Prisma.Decimal(charge.amount).toFixed(2),
          },
        },
      })
    }
    return cas
  })
  if (won.count === 0) return 'ALREADY'
  logger.error('🚨 [OnlineOrderCard] tarjeta apartada que no se vuelve pedido: se libera', {
    chargeId: charge.id,
    venueId: charge.venueId,
    why,
    amountCapturableCents: auth.amountCapturableCents,
    expectedCents: toStripeAmount(new Prisma.Decimal(charge.amount)),
  })
  // r2 R1: la misma liberación que los demás caminos (misma clave del cargo, su bitácora y, si ya la cobraron a mano en Stripe,
  // el registro del cobro con su anomalía). Si Stripe no contesta, el cargo queda RELEASING para el conciliador y aquí se lanza.
  const r = await releaseCharge(charge.id)
  if (r === 'STUCK') throw new Error('No se pudo liberar la tarjeta apartada; el conciliador la retoma')
  return r === 'CAPTURED_OUTSIDE' ? 'CAPTURED_OUTSIDE' : 'RELEASED_LATE'
}

/**
 * Codex r1 C3: el negocio capturó a mano en su Stripe una tarjeta que todavía no era pedido. No se inventa el pedido (el comensal no
 * lo confirmó por Avoqado y la cuenta del cargo no existe): el borrador sigue `PENDING_AUTH` marcado `CAPTURED_OUTSIDE` (nadie lo
 * abandona ni libera dinero ya cobrado), con `MoneyAnomaly` y 🚨 + bitácora UNA sola vez. El comensal sigue viendo «esperando el
 * pago» (no hay un estado «en revisión»); el negocio devuelve el cobro desde su Stripe.
 */
async function capturedOutside(charge: OnlineOrderCharge, auth: AuthorizationState, now: Date): Promise<ConfirmOutcome> {
  const amount = fromStripeAmount(auth.amountReceivedCents).toFixed(2)
  const won = await prisma.$transaction(async tx => {
    const marked = await tx.onlineOrderCharge.updateMany({
      where: {
        id: charge.id,
        status: OnlineOrderChargeStatus.PENDING_AUTH,
        OR: [{ lastError: null }, { lastError: { not: CAPTURED_OUTSIDE } }],
      },
      data: { lastError: CAPTURED_OUTSIDE, paymentIntentId: auth.paymentIntentId, stuckAlertedAt: now },
    })
    if (marked.count !== 1) return false
    // La anomalía (llave única por cargo) es la marca de «una sola vez»: aunque la marca del cargo se pierda y se vuelva a poner.
    const inserted = await tx.moneyAnomaly.createMany({
      data: [
        {
          category: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE',
          stripeEventId: `ooc:CAPTURED_OUTSIDE:${charge.id}`,
          expectedState: {
            venueId: charge.venueId,
            chargeId: charge.id,
            status: 'PENDING_AUTH',
            amount: new Prisma.Decimal(charge.amount).toFixed(2),
          },
          observedState: { paymentIntentId: auth.paymentIntentId, piStatus: auth.piStatus, amountReceived: amount },
        },
      ],
      skipDuplicates: true,
    })
    return inserted.count > 0
  })
  if (!won) return 'CAPTURED_OUTSIDE'
  logger.error('🚨 [OnlineOrderCard] tarjeta capturada fuera de Avoqado antes de ser pedido: no se crea el pedido, devuélvela en Stripe', {
    chargeId: charge.id,
    venueId: charge.venueId,
    paymentIntentId: auth.paymentIntentId,
    amount,
  })
  void logAction({
    venueId: charge.venueId,
    action: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE',
    entity: 'OnlineOrderCharge',
    entityId: charge.id,
    data: { chargeId: charge.id, paymentIntentId: auth.paymentIntentId, amount },
  })
  return 'CAPTURED_OUTSIDE'
}

export async function confirmCardAuthorization(chargeId: string, now: Date = new Date()): Promise<ConfirmOutcome> {
  const charge = await prisma.onlineOrderCharge.findUnique({ where: { id: chargeId } })
  if (!charge || charge.status !== OnlineOrderChargeStatus.PENDING_AUTH) return 'ALREADY'
  // Ya se vio cobrada fuera de Avoqado: no hay nada más que preguntarle a Stripe (lo resuelve una persona).
  if (charge.lastError === CAPTURED_OUTSIDE) return 'CAPTURED_OUTSIDE'
  // Sin sesión guardada todavía no hay qué leer; el conciliador repite la sesión (tarea 7).
  if (!charge.checkoutSessionId) return 'NOT_YET'

  const merchant = chargeMerchant(charge)
  const auth = await getProvider(merchant).getAuthorization(merchant, { checkoutSessionId: charge.checkoutSessionId })
  if (auth.piStatus === 'succeeded') return capturedOutside(charge, auth, now)

  if (auth.piStatus === 'requires_capture' && auth.paymentIntentId) {
    if (auth.amountCapturableCents !== toStripeAmount(new Prisma.Decimal(charge.amount))) {
      return releaseLate(charge, auth, 'AMOUNT_MISMATCH')
    }
    const request = charge.request as unknown as CardDraftRequest
    // S11: un borrador de antes no trae clienta (C9) y nace como hoy; con ella, el pedido nace con su elección canjeada.
    const customerId = request.customerId ?? null
    let created: { orderId: string; onlineOrderId: string; orderNumber: string; premio: boolean } | null
    try {
      created = await withDeadlockRetry(
        async tx => {
          await lockAdmission(tx, charge.venueId)
          const won = await tx.onlineOrderCharge.updateMany({
            where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
            data: {
              status: OnlineOrderChargeStatus.AUTHORIZED,
              paymentIntentId: auth.paymentIntentId,
              authorizedAt: now,
              captureBefore: auth.captureBefore,
              lastError: null,
              stuckAlertedAt: null, // sale de PENDING_AUTH: la alerta del conciliador empieza de cero
            },
          })
          if (won.count === 0) return null
          const orderNumber = await pickOrderNumber(tx, charge.venueId)
          const r = await writeOnlineOrderInTx(tx, {
            venueId: charge.venueId,
            externalId: request.externalId,
            orderNumber,
            quote: request.quote,
            customer: request.customer,
            customerId,
            note: request.note,
            paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
            trackingToken: charge.trackingToken,
            requestHash: charge.requestHash,
            acceptDeadlineAt: new Date(now.getTime() + ACCEPT_TIMEOUT_MINUTES * 60_000),
            whatsappConsent: request.whatsappConsent,
            requiresAcceptance: true, // el borrador de tarjeta nació en «Mi equipo»
            channel: null,
            beneficios: customerId ? { customerId, eleccion: request.beneficios ?? null } : null,
          })
          // R2': con tarjeta el folio nace SÓLO si el total estricto = lo AUTORIZADO (la captura exige esa igualdad); si no, se revierte.
          if (customerId && !r.total.equals(new Prisma.Decimal(charge.amount))) throw new TotalDistintoDelAutorizado(r.total)
          await tx.onlineOrderCharge.update({ where: { id: charge.id }, data: { onlineOrderId: r.onlineOrderId } })
          return {
            orderId: r.orderId,
            onlineOrderId: r.onlineOrderId,
            orderNumber,
            premio: r.premio,
          }
        },
        // S11: canjea en la cuenta nueva: el presupuesto único del candado de la orden (los mismos 15 s / 5 s de antes).
        { etiqueta: 'confirmCardAuthorization', ...ORDER_LOCK_WAIT_BUDGET },
      )
    } catch (error) {
      // La llave ya tiene cuenta (no debería: la guarda de llaves de la tarea 4). Nada se creó: se libera la tarjeta.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return releaseLate(charge, auth, 'EXTERNAL_ID_TAKEN')
      }
      // S11 (R2', R4'): no nace el pedido; se libera con el motivo y el precio nuevo, durables para el seguimiento.
      if (error instanceof TotalDistintoDelAutorizado) {
        return releaseLate(charge, auth, 'PRICE_CHANGED', {
          motivo: 'PRICE_CHANGED',
          cual: null,
          totalEstricto: error.total,
          descartados: [],
        })
      }
      if (customerId && error instanceof AppError && error.code === BENEFIT_UNAVAILABLE) {
        const cual = (error.details as { cual?: BeneficioElegido } | undefined)?.cual ?? null
        return releaseLate(charge, auth, 'BENEFIT_GONE', await precioSinElBeneficio(charge, request, customerId, cual))
      }
      throw error
    }
    if (!created) return 'ALREADY'
    if (created.premio && customerId) despertarPasesTrasCommit(charge.venueId, [customerId])

    emitOnlineOrderCreated(
      charge.venueId,
      { orderId: created.orderId, orderNumber: created.orderNumber, externalId: request.externalId },
      now,
    )
    void logAction({
      venueId: charge.venueId,
      action: 'ONLINE_ORDER_CARD_AUTHORIZED',
      entity: 'OnlineOrder',
      entityId: created.onlineOrderId,
      data: {
        orderNumber: created.orderNumber,
        chargeId: charge.id,
        amount: new Prisma.Decimal(charge.amount).toFixed(2),
        card: auth.card ? { brand: auth.card.brand, last4: auth.card.last4 } : null,
      },
    })
    return 'CREATED'
  }

  // r2 R2: la sesión vencida, o un PaymentIntent cancelado (aunque la sesión diga «complete»), ya no aparta nada: abandonado.
  if (auth.sessionStatus === 'expired' || auth.piStatus === 'canceled') {
    const r = await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
      data: { status: OnlineOrderChargeStatus.ABANDONED },
    })
    return r.count === 1 ? 'ABANDONED' : 'ALREADY'
  }
  return 'NOT_YET'
}

/**
 * S11 (R4'): el beneficio ya no estaba al confirmar. El precio nuevo sale de la MISMA simulación del borrador (con su lugar del
 * semáforo, R2'''), ya fuera de la transacción revertida. Sin lugar o con la base saturada, `totalEstricto: null`: la tienda recotiza.
 */
async function precioSinElBeneficio(
  charge: OnlineOrderCharge,
  request: CardDraftRequest,
  customerId: string,
  cual: BeneficioElegido | null,
): Promise<PrecioCambiado> {
  let total: Prisma.Decimal | null = null
  let descartados: BeneficioElegido[] = cual ? [cual] : []
  try {
    const sim = await simularBeneficios(charge.venueId, fromQuoteSnapshot(request.quote), customerId, request.beneficios ?? {})
    if (sim) {
      total = sim.total
      descartados = [...new Set([...descartados, ...sim.descartados])]
    }
  } catch (error) {
    logger.warn('[OnlineOrderCard] no se pudo calcular el precio nuevo del beneficio perdido (la tienda recotiza)', {
      chargeId: charge.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return { motivo: 'BENEFIT_GONE', cual, totalEstricto: total, descartados }
}
