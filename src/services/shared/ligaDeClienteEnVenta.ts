import prisma from '../../utils/prismaClient'

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

/** ¿Este cliente ya está ligado a la venta? (relectura fuera de la transacción que chocó). */
export async function clienteYaLigadoALaVenta(orderId: string, customerId: string): Promise<boolean> {
  const liga = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
    select: { id: true },
  })
  return liga !== null
}
