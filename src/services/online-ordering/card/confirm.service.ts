// src/services/online-ordering/card/confirm.service.ts
/**
 * Fase 2 — la tarjeta quedó apartada: el borrador (`OnlineOrderCharge`) se vuelve pedido (`Order` + `OnlineOrder`) con los
 * precios congelados del borrador. Idempotente: la llaman el aviso de Stripe, la página de seguimiento y el conciliador; el CAS
 * `PENDING_AUTH → AUTHORIZED` decide al único ganador. Nunca queda una tarjeta apartada sin pedido ni liberación (Codex r2 #5).
 */
import { OnlineOrderChargeStatus, OnlineOrderPaymentMode, Prisma, type OnlineOrderCharge } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getProvider } from '@/services/payments/provider-registry'
import type { AuthorizationState } from '@/services/payments/providers/provider.interface'
import { toStripeAmount } from '@/services/payments/providers/money'
import { ACCEPT_TIMEOUT_MINUTES } from '../constants'
import { TX_OPTIONS, emitOnlineOrderCreated, lockAdmission, pickOrderNumber, writeOnlineOrderInTx } from '../order.service'
import type { CardDraftRequest } from './draft.service'
import { chargeMerchant } from './merchant'

export type ConfirmOutcome = 'CREATED' | 'ALREADY' | 'NOT_YET' | 'ABANDONED' | 'RELEASED_LATE'

/**
 * Apartado que no puede volverse pedido (monto distinto, o la llave ya tiene cuenta): se libera. CAS a `RELEASING` primero (un
 * solo liberador); si Stripe falla, el cargo queda `RELEASING` y el conciliador lo retoma.
 */
async function releaseLate(charge: OnlineOrderCharge, auth: AuthorizationState, why: string): Promise<ConfirmOutcome> {
  const won = await prisma.onlineOrderCharge.updateMany({
    where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
    data: { status: OnlineOrderChargeStatus.RELEASING, paymentIntentId: auth.paymentIntentId, lastError: why },
  })
  if (won.count === 0) return 'ALREADY'
  logger.error('🚨 [OnlineOrderCard] tarjeta apartada que no se vuelve pedido: se libera', {
    chargeId: charge.id,
    venueId: charge.venueId,
    why,
    amountCapturableCents: auth.amountCapturableCents,
    expectedCents: toStripeAmount(new Prisma.Decimal(charge.amount)),
  })
  const merchant = chargeMerchant(charge)
  await getProvider(merchant).voidAuthorization(merchant, {
    paymentIntentId: auth.paymentIntentId!,
    idempotencyKey: `online-order-charge:${charge.id}:release`,
  })
  await prisma.onlineOrderCharge.updateMany({
    where: { id: charge.id, status: OnlineOrderChargeStatus.RELEASING },
    data: { status: OnlineOrderChargeStatus.RELEASED, releasedAt: new Date() },
  })
  return 'RELEASED_LATE'
}

export async function confirmCardAuthorization(chargeId: string, now: Date = new Date()): Promise<ConfirmOutcome> {
  const charge = await prisma.onlineOrderCharge.findUnique({ where: { id: chargeId } })
  if (!charge || charge.status !== OnlineOrderChargeStatus.PENDING_AUTH) return 'ALREADY'
  // Sin sesión guardada todavía no hay qué leer; el conciliador repite la sesión (tarea 7).
  if (!charge.checkoutSessionId) return 'NOT_YET'

  const merchant = chargeMerchant(charge)
  const auth = await getProvider(merchant).getAuthorization(merchant, { checkoutSessionId: charge.checkoutSessionId })

  if (auth.piStatus === 'requires_capture' && auth.paymentIntentId) {
    if (auth.amountCapturableCents !== toStripeAmount(new Prisma.Decimal(charge.amount))) {
      return releaseLate(charge, auth, 'AMOUNT_MISMATCH')
    }
    const request = charge.request as unknown as CardDraftRequest
    let created: { orderId: string; onlineOrderId: string; orderNumber: string } | null
    try {
      created = await prisma.$transaction(async tx => {
        await lockAdmission(tx, charge.venueId)
        const won = await tx.onlineOrderCharge.updateMany({
          where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
          data: {
            status: OnlineOrderChargeStatus.AUTHORIZED,
            paymentIntentId: auth.paymentIntentId,
            authorizedAt: now,
            captureBefore: auth.captureBefore,
            lastError: null,
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
          customerId: null, // C9: el teléfono de la tarjeta no se verificó
          note: request.note,
          paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
          trackingToken: charge.trackingToken,
          requestHash: charge.requestHash,
          acceptDeadlineAt: new Date(now.getTime() + ACCEPT_TIMEOUT_MINUTES * 60_000),
          whatsappConsent: request.whatsappConsent,
        })
        await tx.onlineOrderCharge.update({ where: { id: charge.id }, data: { onlineOrderId: r.onlineOrderId } })
        return { ...r, orderNumber }
      }, TX_OPTIONS)
    } catch (error) {
      // La llave ya tiene cuenta (no debería: la guarda de llaves de la tarea 4). Nada se creó: se libera la tarjeta.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return releaseLate(charge, auth, 'EXTERNAL_ID_TAKEN')
      }
      throw error
    }
    if (!created) return 'ALREADY'

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

  if (auth.sessionStatus === 'expired') {
    const r = await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, status: OnlineOrderChargeStatus.PENDING_AUTH },
      data: { status: OnlineOrderChargeStatus.ABANDONED },
    })
    return r.count === 1 ? 'ABANDONED' : 'ALREADY'
  }
  return 'NOT_YET'
}
