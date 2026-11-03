import type { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { findLiveTerminalCharge } from './orderCancelGuard'
import { paymentCountsAsDrawerCash, type TenderSemanticsPayment } from './tenderSemantics'

/**
 * D10-B (founder, 2-nov: «B», se deja cobrar y sólo se avisa). Una caja intenta cobrar con tarjeta y queda en duda; otra cobra en
 * efectivo la MISMA venta. Nunca se bloquea: si la tarjeta resulta aprobada, ese Payment se registra y grita 🚨 [Sobrepago]
 * (`avisarSobrepago`, lo fija `efectivoConTarjetaEnDuda.integration.test.ts`). Esto sólo deja el rastro de que pasó.
 *
 * 🔴 Se llama con `void`, DESPUÉS del commit y sólo con un cobro NUEVO (los reintentos con la misma llave salen antes): ni una consulta
 * que truena ni una que se cuelga pueden tumbar o demorar el cobro. El efectivo lo decide `paymentCountsAsDrawerCash`; la duda,
 * `findLiveTerminalCharge`.
 * ponytail: sin fila durable, un proceso que muere entre el commit y este aviso pierde el rastro; la alerta del aprobado no depende de él.
 */
export async function avisarEfectivoConTarjetaEnDuda(
  cobro: TenderSemanticsPayment & {
    id: string
    venueId: string
    orderId: string
    amount: Prisma.Decimal | number
    tipAmount: Prisma.Decimal | number
    processedById?: string | null
  },
): Promise<void> {
  const { id: paymentId, venueId, orderId } = cobro
  try {
    const amount = Number(cobro.amount)
    const tipAmount = Number(cobro.tipAmount)
    if (!paymentCountsAsDrawerCash(cobro) || amount + tipAmount <= 0) return
    const enDuda = await findLiveTerminalCharge(prisma, { venueId, orderId })
    if (!enDuda) return
    const { requestId } = enDuda
    logger.warn('⚠️ [Efectivo] Se cobró en efectivo una venta con una tarjeta en duda: si el banco la aprueba, hay que devolver uno', {
      venueId,
      orderId,
      paymentId,
      requestId,
      amount,
      tipAmount,
    })
    await logAction({
      action: 'CASH_WITH_CARD_IN_DOUBT',
      entity: 'Order',
      entityId: orderId,
      venueId,
      staffId: cobro.processedById ?? null,
      data: { requestId, paymentId, amount, tipAmount },
    })
  } catch (error) {
    logger.warn('⚠️ [Efectivo] no se pudo revisar si la venta tenía una tarjeta en duda; el cobro ya quedó', {
      venueId,
      orderId,
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
