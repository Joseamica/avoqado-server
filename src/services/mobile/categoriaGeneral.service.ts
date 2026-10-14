import type { Prisma } from '@prisma/client'

/**
 * La categoría donde cae un producto que llega sin categoría desde las apps.
 *
 * Cada producto vive en una categoría y una cuenta nueva nace sin ninguna: su primer producto rebotaba con
 * «No hay categorías» (14-oct-2026, Novedades coral: 5 intentos; ninguno de los 15 negocios nuevos de 3 semanas
 * tenía categorías). Square deja el producto «Sin categoría»; aquí se crea «General» una sola vez por negocio, igual
 * que una categoría hecha a mano en la app (sin menú: la caja no filtra por menú). Va dentro de la transacción del
 * producto, así que si el alta se rechaza tampoco queda la categoría.
 */
export async function categoriaParaProductoSinCategoria(
  tx: Prisma.TransactionClient,
  venueId: string,
): Promise<{ id: string; creada: boolean }> {
  const primera = () => tx.menuCategory.findFirst({ where: { venueId }, orderBy: { displayOrder: 'asc' }, select: { id: true } })

  const existente = await primera()
  if (existente) return { id: existente.id, creada: false }

  // Dos altas a la vez en un negocio sin categorías crearían dos «General».
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`categoria-general:${venueId}`}))::text`
  const trasEsperar = await primera()
  if (trasEsperar) return { id: trasEsperar.id, creada: false }

  // `skipDuplicates`: una «General» hecha a mano en el mismo instante no toma este candado; chocar con el único
  // (venueId, slug) abortaría la transacción del producto. Si ya estaba, se usa ésa.
  const { count } = await tx.menuCategory.createMany({ data: [{ venueId, name: 'General', slug: 'general' }], skipDuplicates: true })
  const general = await tx.menuCategory.findUnique({ where: { venueId_slug: { venueId, slug: 'general' } }, select: { id: true } })
  if (!general) throw new Error(`No se pudo leer la categoría General del negocio ${venueId}`)
  return { id: general.id, creada: count === 1 }
}
