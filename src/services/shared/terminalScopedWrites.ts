import { Prisma } from '@prisma/client'

import { ConflictError, NotFoundError } from '../../errors/AppError'

/**
 * A qué negocio pertenece la terminal que se va a escribir.
 *
 * Quien lee una terminal dentro de su negocio y después la escribe debe escribirla con la MISMA condición. Si entre la
 * lectura y la escritura la terminal se mudó (una migración del dueño de la organización o del superadmin), la escritura
 * no debe caer en el negocio nuevo: un operador autorizado sólo en A terminaría modificando, borrando o dejándole sus
 * comercios de cobro a una terminal de B (auditorías de Codex del spec «pantalla del cliente», 2026-09-16/17).
 */
export type TerminalWriteScope = { venueId: string } | { organizationId: string }

/** La condición de una terminal dentro de su negocio. Sirve para leer y para escribir. */
export interface ScopedTerminalWhere {
  id: string
  venueId?: string
  venue?: { organizationId: string }
}

/**
 * Sin ámbito (el superadmin y los llamadores internos que ya resolvieron la terminal) filtra sólo por id, como siempre.
 * Con organización, el filtro va por el venue ACTUAL de la terminal, así que también la cubre si el venue entero pasó a
 * otra organización.
 */
export function scopedTerminalWhere(terminalId: string, scope?: TerminalWriteScope): ScopedTerminalWhere {
  if (!scope) return { id: terminalId }
  if ('venueId' in scope) return { id: terminalId, venueId: scope.venueId }
  return { id: terminalId, venue: { organizationId: scope.organizationId } }
}

/**
 * 🔴 EL CANDADO de la fila de una terminal. Lo toman guardar y restablecer el diseño de la pantalla del cliente, el gancho
 * que borra ese diseño cuando la terminal cambia de negocio (`customerDisplayVenueChange.ts`) y la revalidación G4 de
 * `migrateCancel`; copiar el diseño toma el MISMO candado de fila, el de varias terminales en una sola sentencia ordenada
 * por id. Vive aquí, y no en el servicio del diseño, porque el gancho y `migrateCancel` también lo usan: si cada uno
 * abriera el suyo, las operaciones creerían que se están serializando y no lo estarían.
 *
 * Devuelve el `venueId` LEÍDO BAJO EL CANDADO, que es lo único que sirve para revalidar: el que venía en la ruta pudo
 * quedar viejo mientras esperábamos.
 */
export async function lockTerminalRow(tx: Prisma.TransactionClient, terminalId: string): Promise<{ id: string; venueId: string } | null> {
  const filas = await tx.$queryRaw<{ id: string; venueId: string }[]>`
    SELECT id, "venueId" FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE
  `
  return filas[0] ?? null
}

/** Las órdenes de la terminal cambiaron mientras se preparaba su borrado: se reintenta (409). */
export const ORDENES_DE_LA_TERMINAL_CAMBIARON = 'ORDENES_DE_LA_TERMINAL_CAMBIARON'

/**
 * 🔴 Borrar una terminal borra EN CASCADA sus órdenes (`TpvCommandQueue`, FK `ON DELETE CASCADE`). El orden de candados de
 * la terminal es orden → configuración → terminal (cancelar y descartar una mudanza, el permiso de ejecución del protocolo
 * 2; b771c2, 15-nov-2026). Un borrado que tomara la terminal y después, por la cascada, sus órdenes se trancaría con un
 * descarte que ya tiene las órdenes y espera la terminal (Codex r1 de b771c2). Por eso quien borra terminales llama esto,
 * dentro de la misma transacción y JUSTO antes del borrado:
 *   1. bloquea sus órdenes, todas y por id;
 *   2. bloquea las terminales, por id (desde aquí nadie les puede insertar una orden: el INSERT necesita su FK);
 *   3. relee sus órdenes. Si apareció una entre 1 y 2 (una mudanza que encoló su borrado, Codex r3 de b771c2), la cascada
 *      la tomaría DESPUÉS de la terminal y se trancaría con quien ya la tiene (cancelar esa mudanza). En vez de eso, 409
 *      `ORDENES_DE_LA_TERMINAL_CAMBIARON`: la transacción se deshace, suelta todo y la persona vuelve a intentarlo.
 */
export async function bloquearOrdenesAntesDeBorrarTerminal(
  tx: Prisma.TransactionClient,
  where: { terminalId: string } | { venueId: string },
): Promise<void> {
  const terminales =
    'terminalId' in where
      ? Prisma.sql`SELECT t.id FROM "Terminal" t WHERE t.id = ${where.terminalId}`
      : Prisma.sql`SELECT t.id FROM "Terminal" t WHERE t."venueId" = ${where.venueId}`
  const ordenes = () =>
    tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT q.id FROM "TpvCommandQueue" q WHERE q."terminalId" IN (${terminales}) ORDER BY q.id FOR UPDATE OF q`,
    )
  const bloqueadas = new Set((await ordenes()).map(fila => fila.id))
  await tx.$queryRaw(Prisma.sql`${terminales} ORDER BY t.id FOR UPDATE OF t`)
  // Con las terminales tomadas ya no entra ninguna orden: el INSERT de una orden toma FOR KEY SHARE de su terminal y choca
  // con este FOR UPDATE (uno a medio confirmar nos hace esperar a que confirme). Las que entraron antes las ve esta lectura
  // simple (READ COMMITTED, foto nueva por sentencia); no se bloquean aquí, porque eso sería terminal → orden otra vez.
  const ahora = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT q.id FROM "TpvCommandQueue" q WHERE q."terminalId" IN (${terminales}) ORDER BY q.id`,
  )
  if (ahora.some(fila => !bloqueadas.has(fila.id))) {
    throw new ConflictError(
      'La terminal recibió una orden nueva mientras se borraba. Actualiza y vuelve a intentarlo.',
      ORDENES_DE_LA_TERMINAL_CAMBIARON,
    )
  }
}

/**
 * Ejecuta una escritura acotada (`update` o `delete` con `scopedTerminalWhere`). Si la base no encuentra la terminal
 * en ese negocio (P2025), eso es «esta terminal ya no es tuya»: un 404, no un error del servidor.
 */
export async function writeScopedTerminal<T>(write: () => Promise<T>, notFoundMessage: string): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundError(notFoundMessage)
    }
    throw error
  }
}

/**
 * Cuántas terminales tocó un lote de `updateMany` acotados. Una terminal que se mudó entre la lectura y la escritura
 * cuenta cero: ya no es de ese negocio, así que se omite en vez de tumbar el guardado de las demás.
 */
export function countUpdatedTerminals(results: readonly unknown[]): number {
  return results.reduce<number>((total, result) => {
    const count = (result as { count?: unknown } | null)?.count
    return typeof count === 'number' ? total + count : total
  }, 0)
}
