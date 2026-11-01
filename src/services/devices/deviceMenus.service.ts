/**
 * «Menú del aparato»: qué categorías y menús muestra la cuadrícula de cada POS (ANDROID, iOS, WINDOWS).
 *
 * Sin filas en `TerminalMenu` = «Todos los menús» = `TODO` (los dos campos en `null`). Nunca se entrega una lista vacía.
 * `visiblesDe` es la cuenta PURA (sin Prisma) para que el panel cuente por aparato con la misma regla que las apps.
 */

import type { TerminalType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { conDescendientes } from '../menus/categoryTree'

export const DEVICE_MENUS_CODE = 'DEVICE_MENUS'
export const MAX_MENUS_POR_APARATO = 50
export const POS_TERMINAL_TYPES: TerminalType[] = ['POS_ANDROID', 'POS_IOS', 'POS_DESKTOP']

const MAX_ASIGNACIONES = 5000
const MAX_CATEGORIAS = 2000

export type DeviceMenuFilter =
  | { visibleCategoryIds: string[]; visibleMenuIds: string[] }
  | { visibleCategoryIds: null; visibleMenuIds: null }

export const TODO: DeviceMenuFilter = { visibleCategoryIds: null, visibleMenuIds: null }

/**
 * Cuenta pura: las categorías de `menuIds` (de `asignaciones`) más sus subcategorías activas, ordenadas.
 * `categorias` ya viene filtrada a las ACTIVAS. Si no queda ninguna → `TODO`.
 */
export function visiblesDe(
  menuIds: ReadonlyArray<string>,
  asignaciones: ReadonlyArray<{ menuId: string; categoryId: string }>,
  categorias: ReadonlyArray<{ id: string; parentId: string | null }>,
): DeviceMenuFilter {
  const menus = new Set(menuIds)
  const asignadas = asignaciones.filter(a => menus.has(a.menuId)).map(a => a.categoryId)
  const visibles = conDescendientes(asignadas, categorias)
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
