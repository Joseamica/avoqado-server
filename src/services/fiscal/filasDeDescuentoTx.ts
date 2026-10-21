/**
 * IVA por producto, bloque B3a (Codex r1 #6): todas las filas de descuento de UNA orden. La consulta de la orden trae una página
 * y una fila de más (`DESCUENTOS_PARA_CONCEPTOS`); sólo si se pasó se recorren las demás, en páginas acotadas y en orden por
 * `id`, con la misma conexión (la transacción de quien factura, que ya tiene la orden bloqueada). Acotar cada lectura no limita
 * qué venta se puede facturar.
 */
import type { Prisma } from '@prisma/client'
import { DESCUENTOS_PARA_CONCEPTOS, PAGINA_DE_DESCUENTOS } from './descuentoPorRenglon'

export type FilaLeida = { id: string; amount: unknown; reparto?: unknown }

export async function filasDeDescuentoCompletas(
  db: Pick<Prisma.TransactionClient, 'orderDiscount'>,
  orderId: string,
  leidas?: FilaLeida[] | null,
): Promise<FilaLeida[]> {
  if (!leidas || leidas.length <= PAGINA_DE_DESCUENTOS) return leidas ?? []
  const todas: FilaLeida[] = []
  let despuesDe: string | undefined
  for (;;) {
    const pagina = await db.orderDiscount.findMany({
      where: { orderId, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: DESCUENTOS_PARA_CONCEPTOS.select,
      orderBy: { id: 'asc' },
      take: PAGINA_DE_DESCUENTOS,
    })
    todas.push(...pagina)
    if (pagina.length < PAGINA_DE_DESCUENTOS) return todas
    despuesDe = pagina[pagina.length - 1].id
  }
}
