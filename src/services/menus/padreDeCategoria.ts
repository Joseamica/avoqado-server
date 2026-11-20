import prisma from '../../utils/prismaClient'

/**
 * na7522fd (2) · encargo 1df453 (18-nov-2026): el padre de una categoría tiene que ser del MISMO negocio.
 *
 * Antes, crear o editar conectaba `parentId` sólo por id: quien conociera el id de una categoría de OTRO negocio le colgaba una
 * hija activa, y su dueño ya no podía borrarla. El mensaje es el mismo exista o no la categoría en otro lado: no se confirma
 * que un id ajeno existe.
 */
export const MENSAJE_PADRE_FUERA_DEL_NEGOCIO = 'No encontramos la categoría padre en este negocio. Elige otra categoría.'

export async function padreEsDelNegocio(venueId: string, parentId: string): Promise<boolean> {
  // Una categoría eliminada (19-nov) tampoco sirve de padre: el dueño ya no la ve y su hija quedaría escondida.
  const padre = await prisma.menuCategory.findFirst({ where: { id: parentId, venueId, deletedAt: null }, select: { id: true } })
  return Boolean(padre)
}
