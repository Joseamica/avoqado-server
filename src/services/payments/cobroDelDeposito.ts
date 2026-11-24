/**
 * El cobro del depósito de una reserva, en UN solo lugar para el aviso de Stripe y la reconfirmación de la app de clientes
 * (hz:fefa11b6:D20, bloque 0b).
 *
 * Antes, la reconfirmación pasaba a PAID cualquier depósito que no fuera PAID (también uno DEVUELTO o RETENIDO) y las dos vías
 * re-confirmaban una reserva CANCELADA a propósito, con su lugar ya liberado. Ahora, bajo el candado de la fila:
 *  - sólo cobra un depósito en uno de los estados de `desde` y de la MISMA sesión de Stripe que la reserva tiene vigente (otro
 *    enlace instalado en medio ya no recibe el cobro del anterior);
 *  - confirma una reserva viva (PENDING o CONFIRMED) y, como siempre, la que el SISTEMA canceló sólo porque venció el plazo del
 *    depósito (la recuperación de un pago hecho a tiempo cuyo aviso llegó tarde);
 *  - una reserva cancelada por una persona se queda cancelada: el cobro se registra (el dinero sí entró) y se devuelve solo, sin
 *    retención (`devolverCobroDeReservaCancelada`); si la devolución no se completa queda una alerta de dinero, una por sesión.
 *  - cualquier otro estado (ya llegó, no asistió…) no se mueve: sólo se registra el cobro.
 */
import { Prisma, ReservationStatus } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

export const CATEGORIA_COBRO_EN_CANCELADA = 'DEPOSIT_PAID_ON_CANCELLED_RESERVATION'

export type DesenlaceDelCobro = 'CONFIRMADA' | 'COBRADA_EN_CANCELADA' | 'COBRADA' | 'SIN_CAMBIO'

export async function registrarCobroDelDeposito(
  tx: Prisma.TransactionClient,
  a: {
    reservationId: string
    checkoutSessionId: string
    paymentIntentId: string | null
    paidAt: Date
    desde: Array<'PENDING' | 'EXPIRED'>
  },
): Promise<DesenlaceDelCobro> {
  const [r] = await tx.$queryRaw<
    Array<{ status: ReservationStatus; depositStatus: string | null; checkoutSessionId: string | null; cancelledBy: string | null }>
  >`SELECT status, "depositStatus", "checkoutSessionId", "cancelledBy" FROM "Reservation" WHERE id = ${a.reservationId} FOR UPDATE`
  if (!r || r.checkoutSessionId !== a.checkoutSessionId || !a.desde.includes(r.depositStatus as 'PENDING' | 'EXPIRED')) {
    return 'SIN_CAMBIO'
  }
  const vencidaPorElPlazo = r.status === 'CANCELLED' && r.depositStatus === 'EXPIRED' && r.cancelledBy === 'SYSTEM'
  const confirmar = r.status === 'PENDING' || r.status === 'CONFIRMED' || vencidaPorElPlazo
  await tx.reservation.update({
    where: { id: a.reservationId },
    data: {
      depositStatus: 'PAID',
      depositPaidAt: a.paidAt,
      depositProcessorRef: a.paymentIntentId,
      ...(confirmar ? { status: ReservationStatus.CONFIRMED, confirmedAt: new Date() } : {}),
    },
  })
  if (confirmar) return 'CONFIRMADA'
  return r.status === 'CANCELLED' ? 'COBRADA_EN_CANCELADA' : 'COBRADA'
}

/**
 * Después de confirmar la transacción del cobro: el depósito de una reserva ya cancelada se devuelve, sin retención (la cancelación
 * fue antes del cobro). Nunca lanza. Si no quedó devuelto, una alerta de dinero por sesión de Stripe: el aviso y la app pueden pasar
 * los dos por aquí y no deben dejar dos pendientes.
 */
export async function devolverCobroDeReservaCancelada(a: { reservationId: string; venueId: string; checkoutSessionId: string }) {
  try {
    const { handleReservationDepositCancellation } = await import('@/services/dashboard/reservation.dashboard.service')
    await handleReservationDepositCancellation(a.reservationId, a.venueId, { sinRetener: true })
  } catch (err) {
    logger.error('❌ [RESERVATION DEPOSIT] No se pudo devolver el depósito cobrado sobre una reserva cancelada', {
      reservationId: a.reservationId,
      err: (err as Error)?.message,
    })
  }
  try {
    const r = await prisma.reservation.findFirst({
      where: { id: a.reservationId, venueId: a.venueId },
      select: { status: true, depositStatus: true, refundStatus: true },
    })
    if (r?.depositStatus === 'REFUNDED') return
    await prisma.moneyAnomaly.upsert({
      where: { stripeEventId_category: { stripeEventId: `deposito:${a.checkoutSessionId}`, category: CATEGORIA_COBRO_EN_CANCELADA } },
      create: {
        category: CATEGORIA_COBRO_EN_CANCELADA,
        reservationId: a.reservationId,
        stripeEventId: `deposito:${a.checkoutSessionId}`,
        expectedState: { status: 'CANCELLED', depositStatus: 'REFUNDED' },
        observedState: { status: r?.status ?? null, depositStatus: r?.depositStatus ?? null, refundStatus: r?.refundStatus ?? null },
      },
      update: {},
    })
    logger.error('🚨 [RESERVATION DEPOSIT] Depósito cobrado sobre una reserva cancelada y sin devolver', { reservationId: a.reservationId })
  } catch (err) {
    logger.error('❌ [RESERVATION DEPOSIT] No se pudo dejar la alerta del depósito cobrado sobre una cancelada', {
      reservationId: a.reservationId,
      err: (err as Error)?.message,
    })
  }
}
