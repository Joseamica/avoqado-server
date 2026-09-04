import { Prisma } from '@prisma/client'

type ShiftLifecycleLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * Autoridad DB compartida del lifecycle OPEN/CLOSING de un venue.
 *
 * Siempre se toma PRIMERO dentro de una transacción corta y luego se relee Shift. PostgreSQL lo
 * libera al commit/rollback, incluso si el proceso muere. Los writers de cobro conservan su lock
 * de fila OPEN y nunca intentan adquirir éste, por lo que no existe el ciclo fila → advisory.
 */
export async function lockShiftLifecycleForVenue(tx: ShiftLifecycleLockClient, venueId: string): Promise<void> {
  const key = `avoqado:shift-lifecycle:v1:${venueId}`
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}
