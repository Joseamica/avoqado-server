import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'

/**
 * A quién reemplazó cada esquema, para la lista del dashboard (`reemplazadoPor: { id, name } | null`). Sale del ActivityLog que
 * deja el reemplazo atómico (`data.reemplazadoPor`), en DOS consultas para toda la lista, sin N+1 y sin migración. Es historia:
 * un esquema reemplazado y vuelto a activar lo sigue diciendo.
 */
export async function conReemplazadoPor<T extends { id: string }>(
  esquemas: T[],
): Promise<Array<T & { reemplazadoPor: { id: string; name: string } | null }>> {
  const ids = esquemas.map(e => e.id)
  const filas =
    ids.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ original: string; nuevo: string }>>(Prisma.sql`
          SELECT DISTINCT ON ("entityId") "entityId" AS original, data->>'reemplazadoPor' AS nuevo
          FROM "ActivityLog"
          WHERE "entityId" IN (${Prisma.join(ids)}) AND action = 'COMMISSION_CONFIG_UPDATED' AND entity = 'CommissionConfig'
            AND data ? 'reemplazadoPor'
          ORDER BY "entityId", "createdAt" DESC`)
  const nombres = new Map(
    (
      await prisma.commissionConfig.findMany({
        where: { id: { in: filas.map(f => f.nuevo) } },
        select: { id: true, name: true },
        take: filas.length,
      })
    ).map(c => [c.id, c.name]),
  )
  const por = new Map(filas.map(f => [f.original, f.nuevo]))
  return esquemas.map(e => {
    const nuevo = por.get(e.id)
    return { ...e, reemplazadoPor: nuevo && nombres.has(nuevo) ? { id: nuevo, name: nombres.get(nuevo)! } : null }
  })
}
