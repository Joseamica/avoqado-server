// src/services/online-ordering/menu.service.ts
import { ProductType, type Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { appliesNow } from '@/services/mobile/menu.mobile.service'
import {
  MAX_GROUPS_PER_PRODUCT,
  MAX_MENU_CATEGORIES,
  MAX_MENUS,
  MAX_MODIFIERS_PER_GROUP,
  MAX_PRODUCTS_PER_CATEGORY,
  MENU_CACHE_TTL_MS,
} from './constants'

/** R17: tipos que no son comida para recoger. */
export const NON_FOOD_PRODUCT_TYPES: ProductType[] = [
  ProductType.APPOINTMENTS_SERVICE,
  ProductType.CLASS,
  ProductType.EVENT,
  ProductType.DONATION,
]

/** R17: lo que la tienda en línea puede vender. Lo comparten la carta y el cotizador: lo que no se ve, no se vende. */
export const ONLINE_PRODUCT_WHERE = {
  active: true,
  deletedAt: null,
  availableOnline: true,
  // Por peso no: la tienda vende piezas y no pesa (sin `weightQuantity` saldría como pieza).
  soldByWeight: false,
  type: { notIn: NON_FOOD_PRODUCT_TYPES },
} satisfies Prisma.ProductWhereInput

/** Un grupo y una opción de MÁS sobre el tope, a propósito: así se sabe que el producto no cupo completo (R17). */
export const ONLINE_PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  description: true,
  price: true,
  imageUrl: true,
  categoryId: true,
  // H4: el horario PROPIO de la categoría viaja con el producto (el cotizador lo necesita sin releer la categoría).
  category: { select: { name: true, availableFrom: true, availableUntil: true, availableDays: true } },
  modifierGroups: {
    where: { group: { active: true } },
    orderBy: { displayOrder: 'asc' as const },
    take: MAX_GROUPS_PER_PRODUCT + 1,
    select: {
      group: {
        select: {
          id: true,
          name: true,
          required: true,
          allowMultiple: true,
          minSelections: true,
          maxSelections: true,
          modifiers: {
            where: { active: true },
            orderBy: { id: 'asc' as const },
            take: MAX_MODIFIERS_PER_GROUP + 1,
            select: { id: true, name: true, price: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductSelect

export type OnlineProductRow = Prisma.ProductGetPayload<{ select: typeof ONLINE_PRODUCT_SELECT }>

export interface VisibleModifier {
  id: string
  name: string
  price: Prisma.Decimal
}
export interface VisibleGroup {
  id: string
  name: string
  required: boolean
  allowMultiple: boolean
  minSelections: number
  maxSelections: number | null
  modifiers: VisibleModifier[]
}
export interface VisibleProduct {
  id: string
  name: string
  sku: string | null
  description: string | null
  price: Prisma.Decimal
  imageUrl: string | null
  categoryId: string
  /** R3: se guarda en `OrderItem.categoryName`, como TPV y móvil. */
  categoryName: string
  groups: VisibleGroup[]
}
export interface VisibleCategory {
  id: string
  name: string
  /** H10: total de platillos en línea de la categoría (agregado), aunque la lista se haya recortado. */
  productCount: number
  products: VisibleProduct[]
}
export interface VisibleMenu {
  categories: VisibleCategory[]
  /** `true` si algún tope recortó la carta: nunca se recorta en silencio. */
  truncated: boolean
}

/** H4: el horario PROPIO de una categoría (`MenuCategory.availableFrom/Until/Days`; la categoría no tiene fechas). */
export interface CategorySchedule {
  id: string
  availableFrom: string | null
  availableUntil: string | null
  availableDays: string[]
}

export interface PublicMenu {
  generatedAt: string
  truncated: boolean
  categories: Array<{
    id: string
    name: string
    productCount: number
    products: Array<{
      id: string
      name: string
      description: string | null
      price: number
      imageUrl: string | null
      soldOut: boolean
      modifierGroups: Array<{
        id: string
        name: string
        required: boolean
        allowMultiple: boolean
        minSelections: number
        maxSelections: number | null
        modifiers: Array<{ id: string; name: string; price: number }>
      }>
    }>
  }>
}

/** R17: un producto con más grupos u opciones que los topes NO se ofrece ni se cotiza a medias (un obligatorio quedaría fuera). */
export function exceedsQueryLimits(p: OnlineProductRow): boolean {
  return p.modifierGroups.length > MAX_GROUPS_PER_PRODUCT || p.modifierGroups.some(g => g.group.modifiers.length > MAX_MODIFIERS_PER_GROUP)
}

/**
 * M-4: un grupo que nadie puede cumplir deja el platillo imposible de pedir (realista: desactivaron todos los sabores agotados de
 * un obligatorio). La carta no lo ofrece y el cotizador responde `PRODUCT_UNAVAILABLE`. El mínimo efectivo es el del cotizador
 * (un obligatorio pide al menos 1); las opciones son las activas que trae `ONLINE_PRODUCT_SELECT`.
 */
export function isUnsatisfiable(p: OnlineProductRow): boolean {
  return p.modifierGroups.some(({ group: g }) => {
    const min = g.required ? Math.max(1, g.minSelections) : g.minSelections
    return (
      min > g.modifiers.length || // incluye «obligatorio o con mínimo, y 0 opciones activas»
      (!g.allowMultiple && min >= 2) ||
      (g.maxSelections !== null && min > g.maxSelections)
    )
  })
}

export function toVisibleProduct(p: OnlineProductRow): VisibleProduct {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku ?? null,
    description: p.description ?? null,
    price: p.price,
    imageUrl: p.imageUrl ?? null,
    categoryId: p.categoryId,
    categoryName: p.category.name,
    groups: p.modifierGroups.map(pmg => ({
      id: pmg.group.id,
      name: pmg.group.name,
      required: pmg.group.required,
      allowMultiple: pmg.group.allowMultiple,
      minSelections: pmg.group.minSelections,
      maxSelections: pmg.group.maxSelections ?? null,
      modifiers: pmg.group.modifiers.map(m => ({ id: m.id, name: m.name, price: m.price })),
    })),
  }
}

/**
 * ¿Qué categorías se pueden pedir AHORA? Igual que el POS (`appliesNow`), con dos reglas (H4, r2):
 * 1. el horario PROPIO de la categoría (desde/hasta/días) tiene que aplicar en la hora de pared del venue;
 * 2. si la categoría está en menús activos, alguno tiene que aplicar; si no está en ninguno, no restringe.
 * Las asignaciones menú↔categoría se leen SÓLO para las categorías dadas (la carta: ≤ MAX_MENU_CATEGORIES; el cotizador:
 * ≤ MAX_CART_LINES), con `tope + 1`. Si aun así sobran, la categoría que no se pudo evaluar completa NO se ofrece: nunca
 * «sin restricción». Una categoría que no se dio, tampoco.
 */
export async function loadCategoryVisibility(
  venueId: string,
  now: Date,
  categories: CategorySchedule[],
): Promise<(categoryId: string) => boolean> {
  const byId = new Map(categories.map(c => [c.id, c]))
  if (byId.size === 0) return () => false
  const ids = [...byId.keys()]
  // Una asignación es única por (menú, categoría): cada categoría cabe en `MAX_MENUS` menús antes de tocar el tope.
  const tope = ids.length * MAX_MENUS
  const [venue, rows] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
    prisma.menuCategoryAssignment.findMany({
      where: { categoryId: { in: ids }, menu: { venueId, active: true } },
      orderBy: [{ categoryId: 'asc' }, { id: 'asc' }],
      take: tope + 1,
      select: {
        categoryId: true,
        menu: { select: { availableFrom: true, availableUntil: true, availableDays: true, startDate: true, endDate: true } },
      },
    }),
  ])
  const timezone = venue?.timezone || 'America/Mexico_City'

  // Ordenadas por categoría: si sobró una fila, la última categoría leída pudo quedar a medias y las que no aparecen pudieron
  // quedar fuera. Sólo se confía en las leídas antes de la última; ante la duda, la categoría no se ofrece.
  let completas: Set<string> | null = null
  if (rows.length > tope) {
    rows.length = tope
    const ultima = rows[tope - 1].categoryId
    completas = new Set(rows.map(r => r.categoryId).filter(id => id !== ultima))
    logger.warn('[OnlineOrdering] demasiadas asignaciones menú↔categoría: las categorías sin evaluar completas no se ofrecen', {
      venueId,
      tope,
    })
  }

  const menusByCategory = new Map<string, Array<(typeof rows)[number]['menu']>>()
  for (const r of rows) {
    const list = menusByCategory.get(r.categoryId) ?? []
    list.push(r.menu)
    menusByCategory.set(r.categoryId, list)
  }

  return (categoryId: string): boolean => {
    const category = byId.get(categoryId)
    if (!category) return false
    if (completas && !completas.has(categoryId)) return false
    // H4: el horario propio de la categoría, con el MISMO evaluador que los menús (la categoría no tiene fechas).
    if (!appliesNow({ ...category, startDate: null, endDate: null }, now, timezone)) return false
    const menus = menusByCategory.get(categoryId)
    return !menus || menus.length === 0 || menus.some(m => appliesNow(m, now, timezone))
  }
}

/**
 * La carta que el comensal puede pedir AHORA: categorías activas con platillos vendibles en línea (`ONLINE_PRODUCT_WHERE`),
 * sin las categorías cuyo horario (propio o de sus menús) no aplica, y sin productos que no caben completos. SIN caché.
 * R17: sin paginación en v1; si algo se recorta, `truncated` lo dice (medido con tope + 1, H10), cada categoría trae su
 * `productCount` (agregado) y queda un `logger.warn`.
 */
export async function loadVisibleMenu(venueId: string, now: Date = new Date()): Promise<VisibleMenu> {
  const rows = await prisma.menuCategory.findMany({
    where: { venueId, active: true },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: MAX_MENU_CATEGORIES + 1,
    include: {
      products: {
        where: ONLINE_PRODUCT_WHERE,
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        take: MAX_PRODUCTS_PER_CATEGORY + 1,
        select: ONLINE_PRODUCT_SELECT,
      },
    },
  })
  let truncated = rows.length > MAX_MENU_CATEGORIES
  const categories = rows.slice(0, MAX_MENU_CATEGORIES)
  const ids = categories.map(c => c.id)

  const [isVisibleNow, counts] = await Promise.all([
    loadCategoryVisibility(venueId, now, categories),
    // H10 (R17): el total de platillos en línea por categoría, con un agregado: la carta recortada dice cuántos hay.
    ids.length > 0
      ? prisma.product.groupBy({
          by: ['categoryId'],
          where: { venueId, categoryId: { in: ids }, ...ONLINE_PRODUCT_WHERE },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ categoryId: string; _count: { _all: number } }>),
  ])
  const productCount = new Map<string, number>(counts.map(g => [g.categoryId, g._count._all]))

  const out: VisibleCategory[] = []
  for (const c of categories) {
    if (c.products.length > MAX_PRODUCTS_PER_CATEGORY) truncated = true
    const products: VisibleProduct[] = []
    let imposibles = 0
    for (const p of c.products.slice(0, MAX_PRODUCTS_PER_CATEGORY)) {
      if (exceedsQueryLimits(p)) {
        truncated = true
        continue
      }
      // M-4: no es un recorte (no marca `truncated`): ese platillo hoy no se puede pedir, y tampoco cuenta en la categoría.
      if (isUnsatisfiable(p)) {
        imposibles += 1
        continue
      }
      products.push(toVisibleProduct(p))
    }
    if (products.length === 0 || !isVisibleNow(c.id)) continue
    const total = productCount.get(c.id)
    out.push({ id: c.id, name: c.name, productCount: total === undefined ? products.length : total - imposibles, products })
  }
  if (truncated) {
    logger.warn('[OnlineOrdering] la carta pública se recortó por un tope (sin paginación en v1)', {
      venueId,
      categorias: categories.length,
      topes: {
        categorias: MAX_MENU_CATEGORIES,
        platillosPorCategoria: MAX_PRODUCTS_PER_CATEGORY,
        gruposPorPlatillo: MAX_GROUPS_PER_PRODUCT,
      },
    })
  }
  return { categories: out, truncated }
}

const cache = new Map<string, { at: number; value: PublicMenu }>()

export function clearPublicMenuCache(): void {
  cache.clear()
}

/** La carta para la tienda pública, con caché en memoria de 60 s por venue (una sola instancia, sin Redis). */
export async function getPublicMenu(venueId: string, now: Date = new Date()): Promise<PublicMenu> {
  const hit = cache.get(venueId)
  if (hit && now.getTime() - hit.at < MENU_CACHE_TTL_MS) return hit.value

  const visible = await loadVisibleMenu(venueId, now)
  const value: PublicMenu = {
    generatedAt: now.toISOString(),
    truncated: visible.truncated,
    categories: visible.categories.map(c => ({
      id: c.id,
      name: c.name,
      productCount: c.productCount,
      products: c.products.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        imageUrl: p.imageUrl,
        // 1a (R17, desviación 13): lo agotado se apaga desmarcando «en línea»; por inventario llega después.
        soldOut: false,
        modifierGroups: p.groups.map(g => ({
          id: g.id,
          name: g.name,
          required: g.required,
          allowMultiple: g.allowMultiple,
          minSelections: g.minSelections,
          maxSelections: g.maxSelections,
          modifiers: g.modifiers.map(m => ({ id: m.id, name: m.name, price: Number(m.price) })),
        })),
      })),
    })),
  }
  cache.set(venueId, { at: now.getTime(), value })
  return value
}
