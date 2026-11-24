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
 *  - una reserva cancelada por una persona se queda cancelada: el cobro se registra (el dinero sí entró) JUNTO con una alerta de
 *    dinero, en la misma transacción (si el proceso cae antes de devolver, la obligación no se pierde: Codex 0-r2 #2); después se
 *    devuelve sola, sin retención (`devolverCobroDeReservaCancelada`), y si quedó devuelta la alerta se marca resuelta.
 *  - cualquier otro estado (ya llegó, no asistió…) no se mueve: sólo se registra el cobro.
 */
import { Prisma, ReservationStatus } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

export const CATEGORIA_COBRO_EN_CANCELADA = 'DEPOSIT_PAID_ON_CANCELLED_RESERVATION'

/** Los textos con que la conciliación y el aviso de vencimiento cancelan una reserva cuyo depósito no se pagó a tiempo. */
export const MOTIVO_PLAZO_VENCIDO = 'Reservation deposit payment window expired'
export const MOTIVO_SESION_VENCIDA = 'Stripe Checkout session expired'
const MOTIVOS_DE_VENCIMIENTO_DEL_DEPOSITO = [MOTIVO_PLAZO_VENCIDO, MOTIVO_SESION_VENCIDA]

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
  // Orden de candados (Codex 0-r6): la CLASE antes que la reserva, el mismo orden que la cancelación de la clase (que bloquea la
  // clase y luego sus reservas). Al revés, una confirmación y una cancelación se esperaban la una a la otra. Una cita no tiene clase.
  // `FOR SHARE` también espera a una cancelación de la clase en curso y lee su resultado (Codex 0-r5 #1).
  const [previa] = await tx.$queryRaw<Array<{ classSessionId: string | null }>>`
    SELECT "classSessionId" FROM "Reservation" WHERE id = ${a.reservationId}`
  const estadoDeLaClase = async (classSessionId: string, candado: boolean) => {
    const [clase] = candado
      ? await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "ClassSession" WHERE id = ${classSessionId} FOR SHARE`
      : await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "ClassSession" WHERE id = ${classSessionId}`
    return clase?.status ?? null
  }
  const claseAntes = previa?.classSessionId ? await estadoDeLaClase(previa.classSessionId, true) : null

  const [r] = await tx.$queryRaw<
    Array<{
      status: ReservationStatus
      depositStatus: string | null
      checkoutSessionId: string | null
      cancelledBy: string | null
      cancellationReason: string | null
      classSessionId: string | null
    }>
  >`SELECT status, "depositStatus", "checkoutSessionId", "cancelledBy", "cancellationReason", "classSessionId" FROM "Reservation" WHERE id = ${a.reservationId} FOR UPDATE`
  if (!r || r.checkoutSessionId !== a.checkoutSessionId || !a.desde.includes(r.depositStatus as 'PENDING' | 'EXPIRED')) {
    return 'SIN_CAMBIO'
  }
  // ponytail: si en ese instante la reserva cambió de clase, la nueva se lee sin candado (pedirlo ya con la reserva bloqueada
  // volvería al orden que se traba); la ventana es la de mover una reserva vencida de clase en el mismo milisegundo.
  const estadoClase =
    r.classSessionId === (previa?.classSessionId ?? null)
      ? claseAntes
      : r.classSessionId
        ? await estadoDeLaClase(r.classSessionId, false)
        : null
  // Sólo el vencimiento del plazo del depósito (sus dos escritores y sus textos): «SYSTEM» también cancela una clase entera que
  // canceló el negocio (Codex 0-r3 #1), y ésa no se re-confirma. Tampoco la vencida cuya clase se canceló después: la cancelación
  // de la clase sólo toca reservas vivas, así que la vencida conserva su motivo (Codex 0-r4 #1).
  const vencidaPorElPlazo =
    r.status === 'CANCELLED' &&
    r.depositStatus === 'EXPIRED' &&
    r.cancelledBy === 'SYSTEM' &&
    MOTIVOS_DE_VENCIMIENTO_DEL_DEPOSITO.includes(r.cancellationReason ?? '') &&
    estadoClase !== 'CANCELLED'
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
  if (r.status !== 'CANCELLED') return 'COBRADA'
  await tx.moneyAnomaly.upsert({
    where: { stripeEventId_category: { stripeEventId: llaveDeLaAlerta(a.checkoutSessionId), category: CATEGORIA_COBRO_EN_CANCELADA } },
    create: {
      category: CATEGORIA_COBRO_EN_CANCELADA,
      reservationId: a.reservationId,
      stripeEventId: llaveDeLaAlerta(a.checkoutSessionId),
      expectedState: { status: 'CANCELLED', depositStatus: 'REFUNDED' },
      observedState: { status: r.status, depositStatus: 'PAID', cancelledBy: r.cancelledBy },
    },
    update: {},
  })
  logger.error('🚨 [RESERVATION DEPOSIT] Depósito cobrado sobre una reserva cancelada: se devuelve', { reservationId: a.reservationId })
  return 'COBRADA_EN_CANCELADA'
}

/**
 * Si el depósito ya quedó devuelto, la alerta de su cobro se marca resuelta. La llaman la devolución automática y, por si el proceso
 * cayó entre devolver y resolver, el aviso tardío del mismo cobro (Codex 0-r3 #4). Idempotente.
 */
export async function resolverAlertaSiYaSeDevolvio(
  db: Pick<Prisma.TransactionClient, 'reservation' | 'moneyAnomaly'>,
  a: { reservationId: string; venueId: string; checkoutSessionId: string },
) {
  const r = await db.reservation.findFirst({ where: { id: a.reservationId, venueId: a.venueId }, select: { depositStatus: true } })
  if (r?.depositStatus !== 'REFUNDED') return
  await db.moneyAnomaly.updateMany({
    where: { stripeEventId: llaveDeLaAlerta(a.checkoutSessionId), category: CATEGORIA_COBRO_EN_CANCELADA, resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedBy: 'SYSTEM', resolution: 'Devuelto solo al registrar el cobro' },
  })
}

/** Una alerta por sesión de Stripe: el aviso y la app pueden pasar los dos por aquí. */
const llaveDeLaAlerta = (checkoutSessionId: string) => `deposito:${checkoutSessionId}`

/**
 * Después de confirmar la transacción del cobro: el depósito de una reserva ya cancelada se devuelve, sin retención (la cancelación
 * fue antes del cobro). Nunca lanza. Si quedó devuelto, la alerta de dinero que dejó el cobro se marca resuelta; si no, sigue abierta
 * para que alguien lo devuelva.
 */
export async function devolverCobroDeReservaCancelada(a: { reservationId: string; venueId: string; checkoutSessionId: string }) {
  try {
    const { handleReservationDepositCancellation } = await import('@/services/dashboard/reservation.dashboard.service')
    await handleReservationDepositCancellation(a.reservationId, a.venueId, { sinRetener: true })
    await resolverAlertaSiYaSeDevolvio(prisma, a)
  } catch (err) {
    logger.error('❌ [RESERVATION DEPOSIT] No se pudo devolver el depósito cobrado sobre una reserva cancelada', {
      reservationId: a.reservationId,
      err: (err as Error)?.message,
    })
  }
}
