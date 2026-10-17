// src/services/online-ordering/menuAdmin.service.ts
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { MAX_MENU_CATEGORIES } from './constants'
import { ONLINE_PRODUCT_WHERE } from './menu.service'

/**
 * 1b: lo que la tienda PODRÍA vender (mismo filtro que la carta pública), sin exigir que ya esté publicado. La carta le agrega
 * `availableOnline`; la lista del panel además enseña los inactivos (apagados), así que también le quita `active`.
 */
const { availableOnline: _publicado, ...VENDIBLE_ACTIVO } = ONLINE_PRODUCT_WHERE
const { active: _activo, ...VENDIBLE } = VENDIBLE_ACTIVO

const DEFAULT_PAGE_SIZE = 50

export interface OnlineMenuCategorySummary {
  id: string
  name: string
  active: boolean
  total: number
  online: number
  onlineWithoutPhoto: number
}

/**
 * Por categoría (en el orden de la carta, tope 100): platillos vendibles activos, cuántos de ésos están en línea y cuántos de
 * los en línea no tienen foto. Todo con agregados acotados al negocio; los `totals` son del negocio entero (exactos aunque
 * las categorías se recorten).
 */
export async function getOnlineMenuSummary(venueId: string): Promise<{
  categories: OnlineMenuCategorySummary[]
  totals: { total: number; online: number; onlineWithoutPhoto: number }
  truncated: boolean
}> {
  const rows = await prisma.menuCategory.findMany({
    where: { venueId },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: MAX_MENU_CATEGORIES + 1,
    select: { id: true, name: true, active: true },
  })
  const categories = rows.slice(0, MAX_MENU_CATEGORIES)
  const ids = categories.map(c => c.id)

  const total: Prisma.ProductWhereInput = { venueId, ...VENDIBLE_ACTIVO }
  const online: Prisma.ProductWhereInput = { ...total, availableOnline: true }
  const sinFoto: Prisma.ProductWhereInput = { ...online, OR: [{ imageUrl: null }, { imageUrl: '' }] }
  const porCategoria = async (where: Prisma.ProductWhereInput) => {
    const grupos = await prisma.product.groupBy({
      by: ['categoryId'],
      where: { ...where, categoryId: { in: ids } },
      _count: { _all: true },
    })
    return new Map(grupos.map(g => [g.categoryId, g._count._all]))
  }
  const [t, o, s, totalVenue, onlineVenue, sinFotoVenue] = await Promise.all([
    porCategoria(total),
    porCategoria(online),
    porCategoria(sinFoto),
    prisma.product.count({ where: total }),
    prisma.product.count({ where: online }),
    prisma.product.count({ where: sinFoto }),
  ])

  return {
    categories: categories.map(c => ({
      ...c,
      total: t.get(c.id) ?? 0,
      online: o.get(c.id) ?? 0,
      onlineWithoutPhoto: s.get(c.id) ?? 0,
    })),
    totals: { total: totalVenue, online: onlineVenue, onlineWithoutPhoto: sinFotoVenue },
    truncated: rows.length > MAX_MENU_CATEGORIES,
  }
}

/**
 * Platillos vendibles (activos e inactivos) por nombre, de `limit` en `limit` con el cursor nativo de Prisma por `id`.
 * `total` cuenta el mismo filtro sin la página.
 */
export async function listOnlineMenuProducts(p: {
  venueId: string
  categoryId?: string
  search?: string
  cursor?: string
  limit?: number
}) {
  const limit = p.limit ?? DEFAULT_PAGE_SIZE
  const where: Prisma.ProductWhereInput = {
    venueId: p.venueId,
    ...VENDIBLE,
    ...(p.categoryId ? { categoryId: p.categoryId } : {}),
    ...(p.search ? { name: { contains: p.search, mode: 'insensitive' as const } } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      // Prisma busca la fila del cursor SÓLO por id y compara desde ahí (`>=`). Si esa fila ya no cumple el filtro (la borraron,
      // cambió de categoría), un `skip: 1` se comería un platillo bueno; por eso se excluye por id en vez de saltar a ciegas.
      where: p.cursor ? { ...where, id: { not: p.cursor } } : where,
      ...(p.cursor ? { cursor: { id: p.cursor } } : {}),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: { id: true, name: true, price: true, imageUrl: true, active: true, availableOnline: true, categoryId: true },
    }),
    prisma.product.count({ where }),
  ])
  const items = rows.slice(0, limit).map(r => ({ ...r, price: Number(r.price) }))
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null, total }
}
