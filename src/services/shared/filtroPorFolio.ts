import { Prisma } from '@prisma/client'

/**
 * Buscar una venta por su folio (D30, auditoría de apps viejas, 18-nov-2026).
 *
 * El folio de la base es `ORD-0` + 12 cifras con ceros a la izquierda. Buscar dígitos «en cualquier parte» traía la venta …0120 y la
 * …1200 al teclear «000012». El folio corto que imprimen y enseñan las apps son las ÚLTIMAS cifras, así que con sólo dígitos un folio
 * de la base se busca por cómo TERMINA. Los folios que NO son de la base (los de reloj `ORD-1794…`, los de repartos e integraciones,
 * `12AB3`) siguen «en cualquier parte», como siempre (r2 de la auditoría: `179496` debe seguir encontrando `ORD-1794963374538`); y un
 * folio con sufijo (`…-S2`) sale por las últimas cifras de su tronco. Con letras, en cualquier parte.
 */
export function filtroPorFolio(termino: string): Prisma.OrderWhereInput {
  const t = termino.trim()
  if (!/^\d+$/.test(t)) return { orderNumber: { contains: t, mode: 'insensitive' } }
  return {
    OR: [
      { orderNumber: { endsWith: t } },
      { orderNumber: { contains: `${t}-` } },
      { AND: [{ orderNumber: { contains: t } }, { NOT: { orderNumber: { startsWith: 'ORD-0' } } }] },
    ],
  }
}
