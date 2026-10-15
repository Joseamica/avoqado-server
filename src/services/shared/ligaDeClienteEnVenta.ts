import type { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { isDeadlockError, isRetryableDbError } from '../../utils/serializableRetry'

/**
 * La liga de un cliente a una venta (`OrderCustomer`) ante choques de únicos, en UN solo lugar para el POS (móvil y MCP) y la
 * TPV (BAJO-3 + M1/M2 de la ronda 1 post-QA de sellos tardíos, 15-oct-2026).
 *
 * `OrderCustomer` tiene dos únicos que pueden chocar cuando dos «agregar cliente» corren a la vez: `(orderId, customerId)` y el
 * parcial del primario `(orderId) WHERE isPrimary`. Cuál reporta Postgres depende del orden en que revisa los índices (hoy, el
 * de su OID; un `REINDEX CONCURRENTLY` lo puede voltear), así que NO se decide por el índice del error: ante CUALQUIER P2002
 * se RELEE si este cliente quedó ligado a la venta.
 */

/** ¿Es un choque de único (P2002)? Un `PrismaClientKnownRequestError` o cualquier error con ese `code`. */
export function esChoqueDeUnico(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/** Por qué se reintenta una transacción de liga: choque de único, interbloqueo (40P01) o serialización (P2034, P2010/40001). */
export type MotivoDeReintentoDeLiga = 'UNICO' | 'INTERBLOQUEO' | 'SERIALIZACION'

/**
 * R3-2/R3-3 (ronda 3): UN solo clasificador para todos los caminos de liga (POS/MCP, TPV «agregar», «crear y agregar», `/fast`).
 * El `SELECT … FOR NO KEY UPDATE` crudo deja la serialización como P2010/40001 y el interbloqueo como P2010/40P01 (Prisma no los
 * traduce); en una consulta de modelo llegan como P2034 o como error desconocido. `null` = no se reintenta.
 */
export function motivoDeReintentoDeLiga(error: unknown): MotivoDeReintentoDeLiga | null {
  if (esChoqueDeUnico(error)) return 'UNICO'
  if (isDeadlockError(error)) return 'INTERBLOQUEO'
  if (isRetryableDbError(error)) return 'SERIALIZACION'
  return null
}

/** Texto del log de un reintento (los interbloqueos se dicen con esa palabra: las pruebas de los cruces los buscan). */
export function etiquetaDeReintento(motivo: MotivoDeReintentoDeLiga): string {
  return motivo === 'INTERBLOQUEO' ? 'interbloqueo (40P01)' : motivo === 'UNICO' ? 'choque de único (P2002)' : 'serialización'
}

/** ¿Este cliente ya está ligado a la venta? (relectura fuera de la transacción que chocó). */
export async function clienteYaLigadoALaVenta(orderId: string, customerId: string): Promise<boolean> {
  const liga = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
    select: { id: true },
  })
  return liga !== null
}

/**
 * 🔴 R3-2 (ronda 3 post-QA de sellos tardíos; Codex recheck-7 P2-2): el candado de la VENTA para toda escritura de su atribución
 * (ligas del POS, del MCP y de la TPV, quitar cliente, editar invitado y el relleno de `/fast`). Es la PRIMERA sentencia de su
 * transacción. Devuelve `false` si la venta no es de este negocio.
 *
 * `FOR NO KEY UPDATE`, no `FOR UPDATE`:
 *   · serializa contra el cobro (que toma `FOR UPDATE` con `lockExistingOrderForPayment`), contra el reconciliador y el cierre de la
 *     lealtad (que actualizan la fila) y entre estas escrituras (todas toman este mismo modo): la decisión se toma con el estado
 *     vigente;
 *   · y NO choca con el `FOR KEY SHARE` que Postgres toma sobre la venta al revisar una llave foránea. Con `FOR UPDATE`, la liga
 *     (venta → al insertar su vínculo pide `Customer`) y las métricas del cobro (`Customer FOR UPDATE` → al registrar la visita
 *     piden la venta) se interbloqueaban. Así las métricas nunca esperan a una liga, y el camino del cobro no se tocó.
 */
export async function bloquearVentaParaLiga(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { venueId: string; orderId: string },
): Promise<boolean> {
  if (typeof tx.$queryRaw !== 'function') {
    throw new Error('bloquearVentaParaLiga requiere una transacción con $queryRaw')
  }
  const filas = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Order"
    WHERE id = ${input.orderId} AND "venueId" = ${input.venueId}
    FOR NO KEY UPDATE
  `
  return Array.isArray(filas) && filas.length === 1
}
