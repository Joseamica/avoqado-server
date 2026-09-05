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
  // `pg_advisory_xact_lock` devuelve `void`, y Prisma NO sabe deserializar una columna `void` por
  // `$queryRaw` («Failed to deserialize column of type 'void'»): sin el cast, TODA apertura de caja o
  // de turno respondía 500 en un Postgres real (cazado por /full-testing el 5-sep-2026; las pruebas
  // unitarias mockean `$queryRaw`). El cast a texto no cambia el candado — se toma igual y se
  // suelta al cerrar la transacción — sólo le da a Prisma una columna que sí sabe leer. Prueba:
  // tests/integration/shared/shiftLifecycleLock.integration.test.ts (dos sesiones reales).
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`)
}
