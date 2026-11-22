import type { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { DRAWER_CASH_WHERE } from './tenderSemantics'

/** Una tarjeta que llega a registrarse menos de esto después de su intento no es «tardía»: es el registro normal. */
export const TARDIA_DESDE_MS = 60_000
/** Más atrás de esto no se busca efectivo: la ventana la acota la llegada, no un intento de días. */
const VENTANA_MAXIMA_MS = 24 * 60 * 60 * 1000
const CANDIDATOS = 5

export const ACCION_TARJETA_TARDIA_CON_EFECTIVO = 'LATE_CARD_AFTER_CASH'

/** La hora del intento que manda la TPV (epoch ms, número o texto de dígitos). Ilegible o en el futuro ⇒ null: no se avisa. */
export function leerHoraDelIntento(valor: unknown, llegada: Date): Date | null {
  const ms = typeof valor === 'number' ? valor : typeof valor === 'string' && /^\d{1,16}$/.test(valor) ? Number(valor) : NaN
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > llegada.getTime()) return null
  return new Date(ms)
}

/**
 * D7 (encargo a25cd7; founder 2-nov «B»: se deja cobrar y sólo se avisa). En PAGO RÁPIDO cada `/fast` crea su propia venta, así que
 * no hay cuenta con la cual chocar: si una tarjeta quedó «por confirmar», la cajera cobró esa venta en efectivo y DESPUÉS el banco
 * la aprueba (la TPV la registra sola, tarde), entran dos ventas y nadie se entera. Esto deja el rastro: una tarjeta que llega
 * tarde (su intento empezó hace ≥ 1 min) y, entre su intento y su llegada, la MISMA terminal cobró en efectivo el mismo importe.
 *
 * 🔴 Nunca rechaza ni demora: se llama con `void` después del commit, sólo con un cobro NUEVO. Sin la hora del intento (TPV que no la
 * manda) no hay aviso, como hoy. Con cuenta (`recordOrderPayment`) no aplica: ahí la tarjeta tardía ya salta como sobrepago.
 */
export async function avisarTarjetaTardiaConEfectivo(cobro: {
  id: string
  venueId: string
  orderId: string | null
  terminalId: string | null
  method: string | null
  status: string
  amount: Prisma.Decimal | number
  processedById?: string | null
  horaDelIntento: unknown
  llegada: Date
}): Promise<void> {
  const { id: paymentId, venueId, terminalId, llegada } = cobro
  try {
    if (cobro.status !== 'COMPLETED' || (cobro.method !== 'CREDIT_CARD' && cobro.method !== 'DEBIT_CARD') || !terminalId) return
    const intento = leerHoraDelIntento(cobro.horaDelIntento, llegada)
    if (!intento || llegada.getTime() - intento.getTime() < TARDIA_DESDE_MS) return
    const desde = new Date(Math.max(intento.getTime(), llegada.getTime() - VENTANA_MAXIMA_MS))
    const amount = Number(cobro.amount)
    const efectivos = await prisma.payment.findMany({
      where: {
        venueId,
        terminalId,
        status: 'COMPLETED',
        amount: cobro.amount,
        id: { not: paymentId },
        createdAt: { gte: desde, lte: llegada },
        ...DRAWER_CASH_WHERE,
      },
      select: { id: true, orderId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CANDIDATOS,
    })
    if (efectivos.length === 0) return
    const datos = {
      paymentId,
      orderId: cobro.orderId,
      amount,
      cashPaymentIds: efectivos.map(p => p.id),
      cashOrderIds: efectivos.map(p => p.orderId),
      attemptStartedAt: intento.toISOString(),
      recordedAt: llegada.toISOString(),
    }
    // Better Stack vigila «🚨 [Tarjeta tardía]».
    logger.error('🚨 [Tarjeta tardía] Llegó aprobada una tarjeta que estaba por confirmar y en medio se cobró en efectivo lo mismo', {
      venueId,
      terminalId,
      ...datos,
    })
    await logAction({
      action: ACCION_TARJETA_TARDIA_CON_EFECTIVO,
      entity: 'Payment',
      entityId: paymentId,
      venueId,
      staffId: cobro.processedById ?? null,
      data: datos,
    })
  } catch (error) {
    logger.warn('⚠️ [Tarjeta tardía] no se pudo revisar si hubo efectivo en medio; el cobro ya quedó', {
      venueId,
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
