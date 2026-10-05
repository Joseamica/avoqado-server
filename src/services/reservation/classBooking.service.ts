import { Prisma } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'

/**
 * Primitivas de reserva de clase compartidas por el widget público, el dashboard y el conector de pases.
 * El candado FOR UPDATE de la sesión + SERIALIZABLE es lo que impide vender el mismo lugar dos veces
 * (no se puede FOR UPDATE con agregados en Postgres; por eso la suma va aparte, bajo el candado).
 */
export type LockedClassSession = {
  id: string
  productId: string
  startsAt: Date
  endsAt: Date
  duration: number
  capacity: number
  status: string
  assignedStaffId: string | null
}

/**
 * Bloquea la fila de la sesión (FOR UPDATE) y verifica que sea del venue. No valida el estado:
 * cada llamador conserva su propio mensaje. `notFoundMessage` permite conservar el 404 de cada llamador.
 */
export async function lockClassSession(
  tx: Prisma.TransactionClient,
  venueId: string,
  classSessionId: string,
  notFoundMessage = 'Sesion de clase no encontrada',
): Promise<LockedClassSession> {
  const rows = await tx.$queryRaw<LockedClassSession[]>`
    SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status, "assignedStaffId"
    FROM "ClassSession"
    WHERE id = ${classSessionId}
      AND "venueId" = ${venueId}
    FOR UPDATE
  `
  if (rows.length === 0) throw new NotFoundError(notFoundMessage)
  return rows[0]
}

/** Lugares ocupados por reservas activas (PENDING, CONFIRMED, CHECKED_IN). Llamar bajo el candado de la sesión. */
export async function sumOccupiedSeats(tx: Prisma.TransactionClient, classSessionId: string): Promise<number> {
  const r = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM("partySize"), 0) AS total
    FROM "Reservation"
    WHERE "classSessionId" = ${classSessionId}
      AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
  `
  return Number(r[0]?.total ?? 0)
}

/** Lugares ocupados por reservas activas que vinieron de un pase (ligadas a un AggregatorBooking). */
export async function sumPassSeats(tx: Prisma.TransactionClient, classSessionId: string): Promise<number> {
  const r = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(r."partySize"), 0) AS total
    FROM "Reservation" r
    JOIN "AggregatorBooking" b ON b."reservationId" = r.id
    WHERE r."classSessionId" = ${classSessionId}
      AND r.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
  `
  return Number(r[0]?.total ?? 0)
}
