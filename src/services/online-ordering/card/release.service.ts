// src/services/online-ordering/card/release.service.ts
/**
 * Fase 2 — soltar la tarjeta apartada de un cargo en `RELEASING` (lo dejó ahí la transición que rechazó, venció o canceló el
 * pedido, o la liberación tardía de la tarea 5). Nunca lanza: si Stripe falla, el cargo se queda `RELEASING` con `lastError` y el
 * conciliador (tarea 7) lo retoma con la MISMA clave.
 */
import { OnlineOrderChargeStatus, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getProvider } from '@/services/payments/provider-registry'
import { chargeMerchant } from './merchant'

export async function releaseCharge(chargeId: string): Promise<'RELEASED' | 'STUCK'> {
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
    const state = await getProvider(merchant).voidAuthorization(merchant, { paymentIntentId: charge.paymentIntentId, idempotencyKey })
    if (state.piStatus !== 'canceled') throw new Error(`Stripe dejó el PaymentIntent en ${state.piStatus ?? 'desconocido'}`)

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
