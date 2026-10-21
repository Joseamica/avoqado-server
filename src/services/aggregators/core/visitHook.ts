import { Prisma } from '@prisma/client'
import type { CheckInSource } from '@/services/reservation/checkIn.service'
import { enqueuePassOutbox } from './outbox.service'

/** Visitas de pase por reserva: una reserva es de un solo socio, así que normalmente hay 0 o 1. */
const MAX_VISITS_PER_RESERVATION = 5

/**
 * Gancho del check-in del estudio (spec D2, modo `ON_VENUE_CHECKIN`). Lo llama `checkInReservation` dentro de SU
 * transacción y sólo cuando la reserva PASA a `CHECKED_IN` (kiosco, POS, dashboard o coach): si esa reserva tiene una
 * visita de pase esperando la confirmación del estudio, encola la validación al proveedor. Si la transacción del
 * check-in se deshace, la validación también.
 *
 * Vive aparte de `visit.service` porque aquél importa `checkInReservation`: si `checkIn.service` lo importara a él
 * habría un ciclo de módulos. Aquí sólo entra el TIPO de `CheckInSource`.
 *
 * `source: 'PASS'` es el check-in que hace el propio conector en modo `AUTO` (que ya encoló la validación): no hace
 * nada, para no volver a entrar.
 */
export async function onVenueCheckIn(tx: Prisma.TransactionClient, reservationId: string, source: CheckInSource): Promise<void> {
  if (source === 'PASS') return
  const visits = await tx.aggregatorVisit.findMany({
    where: { reservationId, status: 'PENDING' },
    select: { id: true, venueId: true, connectionId: true, connection: { select: { confirmMode: true } } },
    orderBy: { createdAt: 'asc' },
    take: MAX_VISITS_PER_RESERVATION,
  })
  for (const v of visits) {
    if (v.connection.confirmMode !== 'ON_VENUE_CHECKIN') continue
    await enqueuePassOutbox(tx, { venueId: v.venueId, connectionId: v.connectionId, operation: 'VALIDATE_VISIT', aggregatorVisitId: v.id })
  }
}
