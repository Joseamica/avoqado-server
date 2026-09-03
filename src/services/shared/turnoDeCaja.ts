import type { Prisma, PrismaClient } from '@prisma/client'

/** Acepta el cliente de Prisma o un `tx`: los sitios que atan dinero llaman desde ambos. */
export type ShiftReader = Pick<PrismaClient, 'shift'> | Pick<Prisma.TransactionClient, 'shift'>

/**
 * El turno de caja es del NEGOCIO, no de la persona (decisión del founder, 2-sep-2026).
 *
 * Antes cada cobro buscaba «el turno abierto de QUIEN cobra» (`{ venueId, staffId, OPEN }`),
 * y el selector «Vendedor» de Cobrar cambia ese `staffId` en cada cobro: quien no había
 * abierto turno cobraba FUERA de todo turno, sin aviso. Testarudo, 1-sep-2026: 78 de 92
 * cobros ($10,337 de $12,002) sin turno; el dashboard decía $1,772.
 *
 * `openShiftForVenue` ya obliga a UN turno abierto por venue, así que «el abierto del
 * negocio» es único. Quién vendió sigue viviendo en `Payment.processedById`.
 *
 * 🔴 Es el ÚNICO sitio que resuelve el turno abierto para atar dinero. Hay una prueba
 * estática que falla si alguien vuelve a filtrar por `staffId` en los antiguos 8 lookups.
 */
export async function turnoAbiertoDelNegocio(db: ShiftReader, venueId: string): Promise<{ id: string } | null> {
  const shift = await db.shift.findFirst({
    where: { venueId, status: 'OPEN', endTime: null },
    orderBy: { startTime: 'desc' },
    select: { id: true },
  })
  return shift ? { id: shift.id } : null
}
