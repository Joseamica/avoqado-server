/**
 * «Menú del aparato»: qué categorías y menús muestra la cuadrícula de cada POS (ANDROID, iOS, WINDOWS).
 *
 * Sin filas en `TerminalMenu` = «Todos los menús» = `TODO` (los dos campos en `null`). Nunca se entrega una lista vacía.
 * `visiblesDe` es la cuenta PURA (sin Prisma) para que el panel cuente por aparato con la misma regla que las apps.
 */

import type { Prisma, TerminalType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { logAction } from '../dashboard/activity-log.service'
import { conDescendientes } from '../menus/categoryTree'
import { appliesDeviceMenus } from './deviceMenusAppVersion'

export const DEVICE_MENUS_CODE = 'DEVICE_MENUS'
export const MAX_MENUS_POR_APARATO = 50
export const POS_TERMINAL_TYPES: TerminalType[] = ['POS_ANDROID', 'POS_IOS', 'POS_DESKTOP']
/** Tope del servidor para las dos listas de la página (aparatos y opciones), pida lo que pida el cliente. */
export const DEVICE_MENUS_MAX_PAGE_SIZE = 100

const MAX_ASIGNACIONES = 5000
const MAX_CATEGORIAS = 2000

export type DeviceMenuFilter =
  | { visibleCategoryIds: string[]; visibleMenuIds: string[] }
  | { visibleCategoryIds: null; visibleMenuIds: null }

export const TODO: DeviceMenuFilter = { visibleCategoryIds: null, visibleMenuIds: null }

/**
 * Cuenta pura (Ruling 15: la regla que de verdad pinta el aparato): las categorías DIRECTAS de `menuIds` (de `asignaciones`),
 * encendidas o apagadas, más las subcategorías ACTIVAS que cuelgan de ellas, ordenadas. Es la unión de los `categoryIds` que
 * Mesas (`listMenus`) da para esos menús: la cuadrícula nunca miró `MenuCategory.active`. `categorias` ya viene filtrada a las
 * ACTIVAS (sólo lo que se SUMA sale de ahí). Sin ninguna asignada → `TODO`.
 */
export function visiblesDe(
  menuIds: ReadonlyArray<string>,
  asignaciones: ReadonlyArray<{ menuId: string; categoryId: string }>,
  categorias: ReadonlyArray<{ id: string; parentId: string | null }>,
): DeviceMenuFilter {
  const menus = new Set(menuIds)
  const directas = asignaciones.filter(a => menus.has(a.menuId)).map(a => a.categoryId)
  const visibles = new Set([...directas, ...conDescendientes(directas, categorias)])
  if (visibles.size === 0) return TODO
  return { visibleCategoryIds: [...visibles].sort(), visibleMenuIds: [...menus].sort() }
}

// Cada lectura en su propia función: el candado de findMany busca el `take` en los 1200 caracteres que siguen y una acotada
// pegada a otra sin tope la escondería.
function leerFilasDelAparato(venueId: string, terminalId: string) {
  return prisma.terminalMenu.findMany({
    where: { terminalId, menu: { venueId, active: true, appliesToDevices: true } },
    select: { menuId: true },
    orderBy: { menuId: 'asc' },
    take: MAX_MENUS_POR_APARATO,
  })
}

function leerAsignaciones(menuIds: string[]) {
  return prisma.menuCategoryAssignment.findMany({
    where: { menuId: { in: menuIds } },
    select: { menuId: true, categoryId: true },
    orderBy: [{ menuId: 'asc' }, { categoryId: 'asc' }],
    take: MAX_ASIGNACIONES + 1,
  })
}

function leerCategoriasActivasDelNegocio(venueId: string) {
  return prisma.menuCategory.findMany({
    where: { venueId, active: true },
    select: { id: true, parentId: true },
    orderBy: { id: 'asc' },
    take: MAX_CATEGORIAS + 1,
  })
}

/** Qué categorías y menús muestra la cuadrícula de este aparato. Una sola consulta si no eligió nada. */
export async function resolveDeviceMenuFilter(venueId: string, terminalId: string): Promise<DeviceMenuFilter> {
  const filas = await leerFilasDelAparato(venueId, terminalId)
  if (filas.length === 0) return TODO

  // Sin Pro se ignora la elección, pero las filas se quedan para cuando vuelva.
  if (!(await venueHasFeatureAccess(venueId, DEVICE_MENUS_CODE))) return TODO

  const menuIds = filas.map(f => f.menuId)
  const [asignaciones, categorias] = await Promise.all([leerAsignaciones(menuIds), leerCategoriasActivasDelNegocio(venueId)])
  return filtroDelAparato(venueId, terminalId, menuIds, asignaciones, categorias)
}

/** La regla con sus topes: pasado uno, el aparato muestra todo. La usan `/settings` y el conteo del panel. */
function filtroDelAparato(
  venueId: string,
  terminalId: string,
  menuIds: ReadonlyArray<string>,
  asignaciones: ReadonlyArray<{ menuId: string; categoryId: string }>,
  categorias: ReadonlyArray<{ id: string; parentId: string | null }>,
): DeviceMenuFilter {
  if (asignaciones.length > MAX_ASIGNACIONES || categorias.length > MAX_CATEGORIAS) {
    // Nunca se recorta en silencio: el aparato muestra todo y se deja constancia.
    logger.warn('[DeviceMenus] tope pasado: el aparato muestra todo el catálogo', {
      venueId,
      terminalId,
      asignaciones: asignaciones.length,
      categorias: categorias.length,
    })
    return TODO
  }
  return visiblesDe(menuIds, asignaciones, categorias)
}

// ── La página del DASHBOARD «Qué muestra cada aparato» ──────────────────────────────────────────────────────────────────────

export interface DeviceMenusCounts {
  categories: number
  products: number
}

export interface DeviceMenusTerminalRow {
  id: string
  name: string
  type: TerminalType
  model: string | null
  version: string | null
  areaName: string | null
  needsAppUpdate: boolean
  /** Los menús elegidos, con su nombre; `[]` = «Todos los menús». */
  menus: Array<{ id: string; name: string }>
  /** Lo que pinta su cuadrícula HOY: categorías visibles con algún producto activo, y esos productos. Con la app vieja, todo. */
  sees: DeviceMenusCounts
  /** Lo que pintará al actualizar la app: sólo con `needsAppUpdate` y una elección que filtra; si no, `null` (Ruling 11). */
  seesAfterUpdate: DeviceMenusCounts | null
}

export interface DeviceMenusPage {
  /** Lo que ve un aparato en «Todos los menús». */
  everything: DeviceMenusCounts
  terminals: DeviceMenusTerminalRow[]
  total: number
  page: number
  pageSize: number
}

export interface DeviceMenuOption {
  id: string
  name: string
  appliesToOnline: boolean
  categoryCount: number
}

export interface DeviceMenuOptionsPage {
  menus: DeviceMenuOption[]
  total: number
  page: number
  pageSize: number
}

export interface VenueMenuUsage {
  id: string
  name: string
  active: boolean
  appliesToDevices: boolean
  appliesToOnline: boolean
}

export interface VenueMenuUsagePage {
  menus: VenueMenuUsage[]
  total: number
  page: number
  pageSize: number
}

export const MENU_NO_DISPONIBLE_MESSAGE = 'Ese menú no existe, está apagado o no es para aparatos.'

/**
 * El orden de Mesas (`listMenus` del POS): el default primero, luego `displayOrder`, nombre e id. Las consultas paginadas
 * escriben el `id` final a la vista (`[...ORDEN_DE_MESAS_SIN_ID, { id: 'asc' }]`): así lo exige
 * tests/unit/services/pagination-stability.guard.test.ts, que no lee dentro de constantes.
 */
const ORDEN_DE_MESAS_SIN_ID: Prisma.MenuOrderByWithRelationInput[] = [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { name: 'asc' }]
const ORDEN_DE_MESAS: Prisma.MenuOrderByWithRelationInput[] = [...ORDEN_DE_MESAS_SIN_ID, { id: 'asc' }]

/** Un menú que un aparato puede mostrar: del negocio, encendido y marcado «Aparatos». */
const menuParaAparatos = (venueId: string): Prisma.MenuWhereInput => ({ venueId, active: true, appliesToDevices: true })

const pagina = (page: number, pageSize: number) => {
  const take = Math.min(Math.max(Math.trunc(pageSize) || 1, 1), DEVICE_MENUS_MAX_PAGE_SIZE)
  const p = Math.max(Math.trunc(page) || 1, 1)
  return { page: p, pageSize: take, skip: (p - 1) * take }
}

function leerAparatos(venueId: string, where: Prisma.TerminalWhereInput, skip: number, take: number) {
  return prisma.terminal.findMany({
    where,
    select: {
      id: true,
      name: true,
      type: true,
      model: true,
      version: true,
      fulfillmentArea: { select: { name: true } },
      // Una fila hacia un menú de otro negocio, apagado o sólo en línea no se enseña: la regla tampoco la usa.
      menus: {
        where: { menu: menuParaAparatos(venueId) },
        select: { menu: { select: { id: true, name: true } } },
        orderBy: ORDEN_DE_MESAS.map(o => ({ menu: o })),
        take: MAX_MENUS_POR_APARATO,
      },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    skip,
    take,
  })
}
type Aparato = Awaited<ReturnType<typeof leerAparatos>>[number]

/** Un solo conteo de productos activos por categoría para toda la página. Es lo que entrega la API de productos de las apps. */
function contarProductosPorCategoria(venueId: string) {
  return prisma.product.groupBy({ by: ['categoryId'], where: { venueId, active: true, deletedAt: null }, _count: true })
}

function leerMenusParaAparatos(venueId: string, menuIds: string[]) {
  return prisma.menu.findMany({
    where: { id: { in: menuIds }, ...menuParaAparatos(venueId) },
    select: { id: true, name: true },
    orderBy: ORDEN_DE_MESAS,
    take: MAX_MENUS_POR_APARATO,
  })
}

/** Arma las filas con la MISMA regla que entrega `/settings` (`visiblesDe`), sumando en memoria. */
async function armarFilas(
  venueId: string,
  aparatos: Aparato[],
): Promise<{ everything: DeviceMenusCounts; filas: DeviceMenusTerminalRow[] }> {
  const menuIds = [...new Set(aparatos.flatMap(a => a.menus.map(m => m.menu.id)))]
  const [porCategoria, categorias, asignaciones, conPro] = await Promise.all([
    contarProductosPorCategoria(venueId),
    leerCategoriasActivasDelNegocio(venueId),
    menuIds.length ? leerAsignaciones(menuIds) : Promise.resolve([]),
    menuIds.length ? venueHasFeatureAccess(venueId, DEVICE_MENUS_CODE) : Promise.resolve(false),
  ])

  const productosDe = new Map(porCategoria.map(g => [g.categoryId, g._count]))
  const contar = (ids: Iterable<string>): DeviceMenusCounts => {
    let categories = 0
    let products = 0
    for (const id of ids) {
      const n = productosDe.get(id) ?? 0
      if (n > 0) {
        categories++
        products += n
      }
    }
    return { categories, products }
  }

  // «Todos» = lo que pinta la cuadrícula sin filtro: los productos activos y sus categorías, encendidas o apagadas (Ruling 15).
  const everything = contar(productosDe.keys())

  // Si la unión de la página pasa el tope, cada aparato se cuenta con su propia lectura, como en `/settings`: su conteo no
  // depende de sus vecinos de página (Codex r3 #3).
  // ponytail: hasta `pageSize` lecturas, una tras otra, sólo cuando la página pasa las 5000 asignaciones.
  const paginaPasada = asignaciones.length > MAX_ASIGNACIONES
  // El tope de categorías es del negocio, no del aparato: pasado, todos cuentan «todo» y se avisa una sola vez.
  const sinArbol = categorias.length > MAX_CATEGORIAS
  if (sinArbol && menuIds.length) {
    logger.warn('[DeviceMenus] tope de categorías pasado al contar la página: los aparatos cuentan todo el catálogo', {
      venueId,
      categorias: categorias.length,
    })
  }
  const filas: DeviceMenusTerminalRow[] = []
  for (const a of aparatos) {
    const menus = a.menus.map(m => m.menu)
    let filtrado: DeviceMenusCounts | null = null
    if (menus.length && conPro && !sinArbol) {
      const ids = menus.map(m => m.id)
      const { visibleCategoryIds } = filtroDelAparato(
        venueId,
        a.id,
        ids,
        paginaPasada ? await leerAsignaciones(ids) : asignaciones,
        categorias,
      )
      const suyo = visibleCategoryIds ? contar(visibleCategoryIds) : null
      // Si ninguna categoría visible tiene productos, el aparato muestra todo (Codex r1 #5).
      if (suyo && suyo.categories > 0) filtrado = suyo
    }
    // La pantalla no promete lo que el aparato todavía no hace: con la app vieja, `sees` es todo (Ruling 11).
    const needsAppUpdate = !appliesDeviceMenus(a.type, a.version)
    filas.push({
      id: a.id,
      name: a.name,
      type: a.type,
      model: a.model,
      version: a.version,
      areaName: a.fulfillmentArea?.name ?? null,
      needsAppUpdate,
      menus,
      sees: needsAppUpdate ? everything : (filtrado ?? everything),
      seesAfterUpdate: needsAppUpdate ? filtrado : null,
    })
  }
  return { everything, filas }
}

/** Los aparatos POS (no retirados) del negocio, por nombre, con lo que ve cada uno. */
export async function listDeviceMenus(venueId: string, page: number, pageSize: number): Promise<DeviceMenusPage> {
  const p = pagina(page, pageSize)
  const where: Prisma.TerminalWhereInput = { venueId, type: { in: POS_TERMINAL_TYPES }, status: { not: 'RETIRED' } }
  const [aparatos, total] = await Promise.all([leerAparatos(venueId, where, p.skip, p.pageSize), prisma.terminal.count({ where })])
  const { everything, filas } = await armarFilas(venueId, aparatos)
  return { everything, terminals: filas, total, page: p.page, pageSize: p.pageSize }
}

/** Opciones del selector: los menús encendidos y para aparatos, en el orden de Mesas. No baja el catálogo. */
export async function listDeviceMenuOptions(
  venueId: string,
  opts: { search?: string; page: number; pageSize: number },
): Promise<DeviceMenuOptionsPage> {
  const p = pagina(opts.page, opts.pageSize)
  const nombre = opts.search?.trim()
  const where: Prisma.MenuWhereInput = {
    ...menuParaAparatos(venueId),
    ...(nombre ? { name: { contains: nombre, mode: 'insensitive' } } : {}),
  }
  const [menus, total] = await Promise.all([
    prisma.menu.findMany({
      where,
      // Todas las categorías del menú, también las apagadas: el aparato las pinta (Ruling 15).
      select: { id: true, name: true, appliesToOnline: true, _count: { select: { categories: true } } },
      orderBy: [...ORDEN_DE_MESAS_SIN_ID, { id: 'asc' }],
      skip: p.skip,
      take: p.pageSize,
    }),
    prisma.menu.count({ where }),
  ])
  return {
    menus: menus.map(m => ({ id: m.id, name: m.name, appliesToOnline: m.appliesToOnline, categoryCount: m._count.categories })),
    total,
    page: p.page,
    pageSize: p.pageSize,
  }
}

/**
 * Todos los menús del negocio, encendidos y apagados, con dónde se usa cada uno. Es la única lista de menús del MCP: sin ella,
 * un menú que dejó de ser «Aparatos» no se podría volver a encontrar.
 */
export async function listVenueMenuUsage(venueId: string, page: number): Promise<VenueMenuUsagePage> {
  const p = pagina(page, DEVICE_MENUS_MAX_PAGE_SIZE)
  const where: Prisma.MenuWhereInput = { venueId }
  const [menus, total] = await Promise.all([
    prisma.menu.findMany({
      where,
      select: { id: true, name: true, active: true, appliesToDevices: true, appliesToOnline: true },
      orderBy: [...ORDEN_DE_MESAS_SIN_ID, { id: 'asc' }],
      skip: p.skip,
      take: p.pageSize,
    }),
    prisma.menu.count({ where }),
  ])
  return { menus, total, page: p.page, pageSize: p.pageSize }
}

/**
 * Guarda qué menús muestra un aparato POS. `[]` = «Todos los menús». Reemplaza la elección completa.
 * 404 `TERMINAL_NOT_FOUND` si el aparato no es del negocio o no es POS_*; 400 `MENU_NO_DISPONIBLE` si algún menú no es del
 * negocio, está apagado o no es para aparatos. El plan (Pro) lo revisa la ruta. `provenance` (la del MCP) va en la misma fila de
 * bitácora: quien llama no deja otra.
 */
export async function setTerminalMenus(
  venueId: string,
  terminalId: string,
  menuIds: string[],
  actorStaffId: string | null,
  provenance?: Record<string, string>,
): Promise<DeviceMenusTerminalRow> {
  const ids = [...new Set(menuIds)]
  if (ids.length > MAX_MENUS_POR_APARATO) {
    throw new BadRequestError(`Un aparato puede mostrar hasta ${MAX_MENUS_POR_APARATO} menús.`, 'DEMASIADOS_MENUS')
  }

  const aparato = await prisma.terminal.findFirst({
    where: { id: terminalId, venueId, type: { in: POS_TERMINAL_TYPES } },
    select: { id: true, name: true },
  })
  if (!aparato) throw new NotFoundError('Ese aparato no existe en este negocio o no es un punto de venta.', 'TERMINAL_NOT_FOUND')

  const despues = ids.length ? await leerMenusParaAparatos(venueId, ids) : []
  if (despues.length !== ids.length) throw new BadRequestError(MENU_NO_DISPONIBLE_MESSAGE, 'MENU_NO_DISPONIBLE')

  const antes = await prisma.$transaction(async tx => {
    // Dos guardados del mismo aparato a la vez (dos pestañas) chocarían en la llave única: se forman en fila. NO KEY: no frena
    // una venta del aparato que inserta una orden o un pago con llave foránea a él.
    await tx.$executeRaw`SELECT 1 FROM "Terminal" WHERE "id" = ${terminalId} FOR NO KEY UPDATE`
    const previas = await tx.terminalMenu.findMany({
      where: { terminalId, menu: menuParaAparatos(venueId) },
      select: { menu: { select: { id: true, name: true } } },
      orderBy: ORDEN_DE_MESAS.map(o => ({ menu: o })),
      take: MAX_MENUS_POR_APARATO,
    })
    // Todas las filas del aparato, también las que apuntan a menús apagados o de otro negocio: la elección se reemplaza entera.
    await tx.terminalMenu.deleteMany({ where: { terminalId } })
    if (ids.length) await tx.terminalMenu.createMany({ data: ids.map(menuId => ({ terminalId, menuId })) })
    return previas.map(f => f.menu)
  })

  const mismos = antes.length === despues.length && antes.every(m => ids.includes(m.id))
  if (!mismos) {
    void logAction({
      staffId: actorStaffId,
      venueId,
      action: 'TERMINAL_MENUS_UPDATED',
      entity: 'Terminal',
      entityId: terminalId,
      data: { terminalName: aparato.name, antes, despues, ...provenance },
    })
  }

  const { filas } = await armarFilas(venueId, await leerAparatos(venueId, { id: terminalId, venueId }, 0, 1))
  // Borrado entre el guardado y la relectura: un 404 claro, no un 200 sin cuerpo.
  if (!filas[0]) throw new NotFoundError('Ese aparato ya no existe en este negocio.', 'TERMINAL_NOT_FOUND')
  return filas[0]
}
