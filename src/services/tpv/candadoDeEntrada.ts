import type { Prisma } from '@prisma/client'

import prisma from '../../utils/prismaClient'

/**
 * Un solo «¿ya tiene entrada? → crearla» a la vez por persona, en cualquier sucursal, venga del POS o de la TPV.
 *
 * Sin esto, dos peticiones casi juntas (el reintento de una app cuya primera respuesta tardó) leían las dos «no tiene
 * entrada» y creaban DOS checadas abiertas: el esquema no lo impide. Lo encontró Codex al revisar la foto de entrada
 * (r1 #4, 15-nov); ya pasaba antes de la foto. Candado de Postgres que se suelta solo al terminar la transacción (sin Redis).
 * Es de la persona, no de la sucursal (Codex 26-nov sobre #659, r3): así la corrección de una salida olvidada, que busca su
 * siguiente entrada en todas sus sucursales, espera a la que se guarda en cualquiera de ellas.
 */
export function conCandadoDeEntrada<T>(staffId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tomarCandadoDeEntrada(tx, staffId)
    return fn(tx)
  })
}

/** El mismo candado dentro de una transacción que ya existe (la corrección de una salida olvidada, para no encimarse). */
export async function tomarCandadoDeEntrada(tx: Prisma.TransactionClient, staffId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`time-entry-clock-in:${staffId}`}, 0))::text`
}
