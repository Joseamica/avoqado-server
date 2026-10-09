/**
 * Quién cobra cada categoría cuando varios esquemas la reclaman (fase 3 de Pago al personal, FT-GRAVES S-SOLAPE, dinero).
 *
 * Medido en la QA (D1): dos esquemas activos que comparten una categoría pagaban LOS DOS, aunque la pantalla promete «se pagará
 * una sola vez, con el de mayor prioridad». Ahora cada categoría tiene UN dueño: el primer esquema que la reclama en
 * `ORDEN_DE_ESQUEMAS` (mayor prioridad; en un empate, el más nuevo, el mismo orden de la lista de esquemas). Cada esquema cobra
 * sólo las categorías de las que es dueño, y el general sigue cobrando el sobrante.
 */
import { Prisma } from '@prisma/client'

/** El orden ÚNICO de los esquemas: el de la lista del dashboard, con el id para que un empate exacto también sea estable. */
export const ORDEN_DE_ESQUEMAS: Prisma.CommissionConfigOrderByWithRelationInput[] = [
  { priority: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
]

/** Las categorías de las que es dueño cada esquema, por id. Recibe los esquemas YA en `ORDEN_DE_ESQUEMAS`. */
export function categoriasPropias(esquemas: Array<{ id: string; categoryIds: string[] }>): Map<string, string[]> {
  const tomadas = new Set<string>()
  const propias = new Map<string, string[]>()
  for (const esquema of esquemas) {
    const mias = [...new Set(esquema.categoryIds)].filter(c => !tomadas.has(c))
    for (const c of mias) tomadas.add(c)
    propias.set(esquema.id, mias)
  }
  return propias
}
