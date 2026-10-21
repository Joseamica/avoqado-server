import { Prisma } from '@prisma/client'
import { enqueuePassOutbox } from './outbox.service'

/**
 * El estudio canceló (o quitó de la clase) una reserva desde Avoqado. Si era de un socio de pase aceptado, se marca
 * `CANCELLED` y se encola la baja en el proveedor, que le avisa al socio. Sin esto el socio sigue viendo su reserva,
 * llega, y su check-in se liga a una reserva cancelada (en `AUTO` se cobraba igual; en `ON_VENUE_CHECKIN` vencía).
 *
 * Va dentro de la MISMA transacción que la cancelación. Una reserva que no es de pase cuesta una búsqueda por llave
 * única y nada más. El cambio de `decision` lleva candado de estado: si el socio la canceló en ese mismo instante
 * (`ingestBookingCancelled`), no se le pide al proveedor cancelar algo que él mismo ya canceló.
 */
export async function cancelPassBookingFromVenue(tx: Prisma.TransactionClient, reservationId: string): Promise<void> {
  const booking = await tx.aggregatorBooking.findUnique({
    where: { reservationId },
    select: { id: true, connectionId: true, venueId: true, decision: true },
  })
  if (!booking || booking.decision !== 'ACCEPTED') return
  const res = await tx.aggregatorBooking.updateMany({ where: { id: booking.id, decision: 'ACCEPTED' }, data: { decision: 'CANCELLED' } })
  if (res.count === 0) return
  await enqueuePassOutbox(tx, {
    venueId: booking.venueId,
    connectionId: booking.connectionId,
    operation: 'CANCEL_BOOKING',
    aggregatorBookingId: booking.id,
  })
}
