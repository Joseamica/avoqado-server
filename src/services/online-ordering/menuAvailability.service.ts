import type { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { clearPublicMenuCache } from './menu.service'

/** Marca o desmarca platillos para la tienda en línea. Siempre dentro del venue; nunca toca los borrados ni `active`. */
export async function setOnlineAvailability(p: {
  venueId: string
  availableOnline: boolean
  productIds?: string[]
  categoryIds?: string[]
  allProducts?: boolean
  actorStaffId: string | null
}): Promise<{ updated: number }> {
  const or: Prisma.ProductWhereInput[] = []
  if (p.productIds?.length) or.push({ id: { in: p.productIds } })
  if (p.categoryIds?.length) or.push({ categoryId: { in: p.categoryIds } })
  if (!p.allProducts && or.length === 0) {
    throw new BadRequestError('Indica qué platillos cambiar (ids, categorías o todo el menú).', 'NOTHING_TO_UPDATE')
  }

  const result = await prisma.product.updateMany({
    where: { venueId: p.venueId, deletedAt: null, ...(p.allProducts ? {} : { OR: or }) },
    data: { availableOnline: p.availableOnline },
  })
  clearPublicMenuCache()

  void logAction({
    staffId: p.actorStaffId,
    venueId: p.venueId,
    action: 'ONLINE_MENU_AVAILABILITY_UPDATED',
    entity: 'Product',
    data: {
      availableOnline: p.availableOnline,
      updated: result.count,
      allProducts: p.allProducts === true,
      productIds: p.productIds?.length ?? 0,
      categoryIds: p.categoryIds?.length ?? 0,
    },
  })
  return { updated: result.count }
}
