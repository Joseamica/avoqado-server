import { Prisma } from '@prisma/client'

/** Un solo escritor por persona y sede (spec RH §3.2). Mismo patrón que stripe.service.ts:637. */
export async function tomarCandadoPersona(tx: Prisma.TransactionClient, venueId: string, staffId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:rh-asignacion:v1:${venueId}:${staffId}`}, 0))::text`,
  )
}
