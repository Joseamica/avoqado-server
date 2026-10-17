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
  MENU_CACHE_MAX_VENUES,
  MENU_CACHE_TTL_MS,
  MENU_MAX_GROUP_LINKS_TOTAL,
  MENU_MAX_OPTION_ENTRIES_TOTAL,
  MENU_MAX_OPTIONS_TOTAL,
  MENU_MAX_PRODUCTS_TOTAL,
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
 * un obligatorio). La carta no lo ofrece y el cotizador responde `PRODUCT_UNAVAILABLE`. Es exactamente lo que el cotizador no puede
 * aceptar: el mínimo efectivo es el suyo (un obligatorio pide al menos 1) y él cuenta CANTIDADES, así que un grupo de varias
 * opciones con mínimo mayor que las activas sí se llena repitiendo una. Las opciones son las activas de `ONLINE_PRODUCT_SELECT`.
 */
export function isUnsatisfiable(p: OnlineProductRow): boolean {
  return p.modifierGroups.some(({ group: g }) => {
    const min = g.required ? Math.max(1, g.minSelections) : g.minSelections
    return (
      (min >= 1 && g.modifiers.length === 0) || // ninguna opción activa
      (!g.allowMultiple && min >= 2) || // la selección única nunca llega a 2
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

/** Lo que la carta lee de cada platillo (sus grupos se cuentan y se leen después, sólo si caben: P1-09). */
const MENU_PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  description: true,
  price: true,
  imageUrl: true,
  categoryId: true,
} satisfies Prisma.ProductSelect

/**
 * Filas leídas «por dueño» (los vínculos de cada platillo, las opciones de cada grupo) con `take` = las contadas + 1, ordenadas
 * por dueño. Un dueño está completo si trajo exactamente las que se contaron; si llegó la fila de más (alguien agregó entre el
 * conteo y la lectura), el dueño de esa fila pudo quedar a medias y tampoco cuenta. Devuelve SÓLO los completos ([] si contó 0).
 */
function completos<T>(filas: T[], dueno: (f: T) => string, contadas: Map<string, number>): Map<string, T[]> {
  let total = 0
  for (const n of contadas.values()) total += n
  const out = new Map<string, T[]>([...contadas.keys()].map(k => [k, []]))
  for (const f of filas.slice(0, total)) out.get(dueno(f))?.push(f)
  const aMedias = filas.length > total ? dueno(filas[total]) : undefined
  for (const [k, n] of contadas) if (k === aMedias || out.get(k)!.length !== n) out.delete(k)
  return out
}

/**
 * La carta que el comensal puede pedir AHORA: categorías activas con platillos vendibles en línea (`ONLINE_PRODUCT_WHERE`),
 * sin las categorías cuyo horario (propio o de sus menús) no aplica, y sin productos que no caben completos. SIN caché.
 * R17: sin paginación en v1; si algo se recorta, `truncated` lo dice (medido con tope + 1, H10), cada categoría trae su
 * `productCount` (agregado) y queda un `logger.warn`.
 * P1-09: presupuesto GLOBAL por consulta (≤ 101 categorías, ≤ 401 platillos, ≤ 2,001 vínculos, ≤ 4,001 opciones) y de la
 * respuesta (≤ 20,000 entradas de opciones, contando cada vez que una aparece en un platillo). Cada nivel
 * se CUENTA antes de leerse y se reparte en el orden de la carta: se lee sólo lo que cabe, y un platillo que no cabe completo
 * no sale (ni se lee). Los conteos son `groupBy` acotados por `IN` a lo ya leído; nunca un `_count` de relación, que Prisma
 * compila como un agregado de la tabla entera (de todos los negocios) metido en un JOIN.
 */
export async function loadVisibleMenu(venueId: string, now: Date = new Date()): Promise<VisibleMenu> {
  const rows = await prisma.menuCategory.findMany({
    where: { venueId, active: true },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: MAX_MENU_CATEGORIES + 1,
    select: { id: true, name: true, availableFrom: true, availableUntil: true, availableDays: true },
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

  // 1. Platillos. Cada categoría visible lee min(sus platillos, MAX_PRODUCTS_PER_CATEGORY, lo que quede del presupuesto), en el
  //    orden de la carta y con el conteo exacto. Las que caben enteras van en UNA consulta (+1 para notar si alguien agregó);
  //    cada recortada lee su parte aparte —a lo más 2: cada una deja el presupuesto en 200 o en 0—, así una categoría enorme no
  //    se come las filas de las que siguen.
  const plan = new Map<string, number>()
  let restantes = MENU_MAX_PRODUCTS_TOTAL
  for (const c of categories) {
    const total = productCount.get(c.id) ?? 0
    if (total === 0 || !isVisibleNow(c.id)) continue
    const n = Math.min(total, MAX_PRODUCTS_PER_CATEGORY, restantes)
    if (n < total) truncated = true
    if (n > 0) plan.set(c.id, n)
    restantes -= n
  }
  const enteras = [...plan.keys()].filter(id => plan.get(id) === productCount.get(id))
  const recortadas = [...plan.keys()].filter(id => plan.get(id) !== productCount.get(id))
  const sumaEnteras = enteras.reduce((s, id) => s + plan.get(id)!, 0)
  const leer = (categoryIds: string[], filas: number) =>
    prisma.product.findMany({
      where: { venueId, categoryId: { in: categoryIds }, ...ONLINE_PRODUCT_WHERE },
      orderBy: [{ categoryId: 'asc' }, { displayOrder: 'asc' }, { id: 'asc' }],
      take: filas,
      select: MENU_PRODUCT_SELECT,
    })
  type Platillo = Awaited<ReturnType<typeof leer>>[number]
  const lecturas: Platillo[][] = await Promise.all([
    enteras.length > 0 ? leer(enteras, sumaEnteras + 1) : Promise.resolve([]),
    ...recortadas.map(id => leer([id], plan.get(id)!)),
  ])
  if (lecturas[0].length > sumaEnteras) truncated = true // cambió entre el conteo y la lectura
  const platillosDe = new Map<string, Platillo[]>()
  for (const p of lecturas.flat()) {
    const lista = platillosDe.get(p.categoryId) ?? []
    if (lista.length < plan.get(p.categoryId)!) lista.push(p)
    platillosDe.set(p.categoryId, lista)
  }

  // 2. Grupos (vínculos platillo↔grupo), repartidos en el orden de la carta con el conteo de cada platillo. El que no cabe
  //    COMPLETO —más de MAX_GROUPS_PER_PRODUCT o más de lo que queda— no sale, y sus grupos no se leen (R17).
  const leidos = categories.flatMap(c => platillosDe.get(c.id) ?? [])
  const conteoDeVinculos =
    leidos.length > 0
      ? await prisma.productModifierGroup.groupBy({
          by: ['productId'],
          where: { productId: { in: leidos.map(p => p.id) }, group: { active: true } },
          _count: { _all: true },
        })
      : []
  const vinculosDe = new Map(conteoDeVinculos.map(g => [g.productId, g._count._all]))
  const elegidos: Platillo[] = []
  const gruposContados = new Map<string, number>()
  let vinculos = 0
  for (const p of leidos) {
    const n = vinculosDe.get(p.id) ?? 0
    if (n > MAX_GROUPS_PER_PRODUCT || vinculos + n > MENU_MAX_GROUP_LINKS_TOTAL) {
      truncated = true
      continue
    }
    elegidos.push(p)
    gruposContados.set(p.id, n)
    vinculos += n
  }
  const filasDeVinculos =
    vinculos > 0
      ? await prisma.productModifierGroup.findMany({
          where: { productId: { in: elegidos.filter(p => gruposContados.get(p.id)! > 0).map(p => p.id) }, group: { active: true } },
          orderBy: [{ productId: 'asc' }, { displayOrder: 'asc' }, { id: 'asc' }],
          take: vinculos + 1,
          select: {
            productId: true,
            group: {
              select: {
                id: true,
                name: true,
                required: true,
                allowMultiple: true,
                minSelections: true,
                maxSelections: true,
              },
            },
          },
        })
      : []
  const gruposDe = completos(filasDeVinculos, v => v.productId, gruposContados)

  // 3. Opciones, igual pero por grupo: el grupo que comparten varios platillos se cuenta y se lee una vez. En la respuesta sí se
  //    repite en cada platillo: esas ENTRADAS tienen su propio tope, y el platillo que lo pasaría tampoco sale.
  const gruposLeidos = [...new Set([...gruposDe.values()].flat().map(v => v.group.id))]
  const conteoDeOpciones =
    gruposLeidos.length > 0
      ? await prisma.modifier.groupBy({ by: ['groupId'], where: { groupId: { in: gruposLeidos }, active: true }, _count: { _all: true } })
      : []
  const opcionesDeGrupo = new Map(conteoDeOpciones.map(g => [g.groupId, g._count._all]))
  const cuantas = (groupId: string) => opcionesDeGrupo.get(groupId) ?? 0
  const candidatos: Array<{ p: Platillo; vinculos: typeof filasDeVinculos }> = []
  const opcionesContadas = new Map<string, number>()
  let opciones = 0
  let entradas = 0
  for (const p of elegidos) {
    const vs = gruposDe.get(p.id)
    const nuevos = (vs ?? []).filter(v => !opcionesContadas.has(v.group.id))
    const suma = nuevos.reduce((s, v) => s + cuantas(v.group.id), 0)
    const susEntradas = (vs ?? []).reduce((s, v) => s + cuantas(v.group.id), 0)
    if (
      !vs || // cambió entre el conteo y la lectura
      vs.some(v => cuantas(v.group.id) > MAX_MODIFIERS_PER_GROUP) ||
      opciones + suma > MENU_MAX_OPTIONS_TOTAL ||
      entradas + susEntradas > MENU_MAX_OPTION_ENTRIES_TOTAL
    ) {
      truncated = true
      continue
    }
    for (const v of nuevos) opcionesContadas.set(v.group.id, cuantas(v.group.id))
    opciones += suma
    entradas += susEntradas
    candidatos.push({ p, vinculos: vs })
  }
  const filasDeOpciones =
    opciones > 0
      ? await prisma.modifier.findMany({
          where: { groupId: { in: [...opcionesContadas].filter(([, n]) => n > 0).map(([id]) => id) }, active: true },
          orderBy: [{ groupId: 'asc' }, { id: 'asc' }],
          take: opciones + 1,
          select: { id: true, name: true, price: true, groupId: true },
        })
      : []
  const opcionesDe = completos(filasDeOpciones, o => o.groupId, opcionesContadas)

  const categoria = new Map(categories.map(c => [c.id, c]))
  const productos = new Map<string, VisibleProduct[]>()
  const imposibles = new Map<string, number>()
  for (const { p, vinculos: vs } of candidatos) {
    if (vs.some(v => !opcionesDe.has(v.group.id))) {
      truncated = true // cambió entre el conteo y la lectura
      continue
    }
    const row: OnlineProductRow = {
      ...p,
      category: categoria.get(p.categoryId)!,
      modifierGroups: vs.map(v => ({ group: { ...v.group, modifiers: opcionesDe.get(v.group.id)! } })),
    }
    // M-4: no es un recorte (no marca `truncated`): ese platillo hoy no se puede pedir, y tampoco cuenta en la categoría.
    if (isUnsatisfiable(row)) {
      imposibles.set(p.categoryId, (imposibles.get(p.categoryId) ?? 0) + 1)
      continue
    }
    const lista = productos.get(p.categoryId) ?? []
    lista.push(toVisibleProduct(row))
    productos.set(p.categoryId, lista)
  }

  const out: VisibleCategory[] = []
  for (const c of categories) {
    const products = productos.get(c.id)
    if (!products) continue
    out.push({ id: c.id, name: c.name, productCount: productCount.get(c.id)! - (imposibles.get(c.id) ?? 0), products })
  }
  if (truncated) {
    logger.warn('[OnlineOrdering] la carta pública se recortó por un tope (sin paginación en v1)', {
      venueId,
      categorias: categories.length,
      topes: {
        categorias: MAX_MENU_CATEGORIES,
        platillosPorCategoria: MAX_PRODUCTS_PER_CATEGORY,
        platillos: MENU_MAX_PRODUCTS_TOTAL,
        gruposPorPlatillo: MAX_GROUPS_PER_PRODUCT,
        vinculos: MENU_MAX_GROUP_LINKS_TOTAL,
        opcionesPorGrupo: MAX_MODIFIERS_PER_GROUP,
        opciones: MENU_MAX_OPTIONS_TOTAL,
        entradasDeOpciones: MENU_MAX_OPTION_ENTRIES_TOTAL,
      },
    })
  }
  return { categories: out, truncated }
}

/** P2-07: a lo más MENU_CACHE_MAX_VENUES negocios; el Map guarda el orden de llegada, así el primero es el guardado hace más. */
const cache = new Map<string, { at: number; value: PublicMenu }>()
/** P1-09: una sola recarga en curso por negocio; con la caché fría, N peticiones simultáneas comparten una lectura. */
const recargas = new Map<string, Promise<PublicMenu>>()

/**
 * A11: con `venueId` borra sólo la carta de ESE negocio (lo normal); sin él, todas (pruebas o mantenimiento explícito). También
 * descarta la recarga en curso: pudo leer antes del cambio, así que no se guarda y la siguiente petición lee de nuevo.
 */
export function clearPublicMenuCache(venueId?: string): void {
  if (venueId === undefined) {
    cache.clear()
    recargas.clear()
  } else {
    cache.delete(venueId)
    recargas.delete(venueId)
  }
}

type PublicModifiers = PublicMenu['categories'][number]['products'][number]['modifierGroups'][number]['modifiers']

function toPublicMenu(visible: VisibleMenu, now: Date): PublicMenu {
  // Un grupo compartido lleva sus opciones UNA vez en memoria (mismo JSON): la carta en caché no se multiplica por platillo.
  const opcionesDe = new Map<string, PublicModifiers>()
  const opciones = (g: VisibleGroup): PublicModifiers => {
    let lista = opcionesDe.get(g.id)
    if (!lista) opcionesDe.set(g.id, (lista = g.modifiers.map(m => ({ id: m.id, name: m.name, price: Number(m.price) }))))
    return lista
  }
  return {
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
          modifiers: opciones(g),
        })),
      })),
    })),
  }
}

/**
 * La carta para la tienda pública, con caché en memoria de 60 s por venue (una sola instancia, sin Redis). Una recarga que falla
 * no se guarda: la rechazan las peticiones que la esperaban y la siguiente vuelve a leer.
 */
export async function getPublicMenu(venueId: string, now: Date = new Date()): Promise<PublicMenu> {
  const hit = cache.get(venueId)
  if (hit && now.getTime() - hit.at < MENU_CACHE_TTL_MS) return hit.value
  const enCurso = recargas.get(venueId)
  if (enCurso) return enCurso

  const recarga: Promise<PublicMenu> = loadVisibleMenu(venueId, now)
    .then(visible => {
      const value = toPublicMenu(visible, now)
      if (recargas.get(venueId) === recarga) {
        cache.delete(venueId) // al final del orden: el primero del Map sigue siendo el guardado hace más
        cache.set(venueId, { at: now.getTime(), value })
        if (cache.size > MENU_CACHE_MAX_VENUES) cache.delete(cache.keys().next().value!)
      }
      return value
    })
    .finally(() => {
      if (recargas.get(venueId) === recarga) recargas.delete(venueId)
    })
  recargas.set(venueId, recarga)
  return recarga
}
