/**
 * Aparatos claros, Paso 1 (8-nov-2026): qué categorías del Ruteo son «Sólo vale · sin comanda».
 *
 * No hay liga directa categoría → área de vales: el área de un renglón la pone el SERVIDOR desde `Terminal.fulfillmentAreaId`
 * de la PC que lo manda, y `FulfillmentArea.sendsComanda=false` lo aplica el POS al EMITIR (sale sólo el vale). Lo que liga una
 * categoría con una PC es su menú del aparato (`resolveDeviceMenuFilter`; sin menús = todas).
 *
 * Regla: la categoría la muestra alguna PC activa que emite vales de un área activa SIN comanda, y ninguna PC activa que emite
 * vales de un área CON comanda. Sólo con los vales prendidos en el negocio (plan + interruptor).
 * 🔴 Límite (Codex r1 #1): el menú del aparato sólo filtra la CUADRÍCULA; búsqueda, pistola y «Ver todo» venden todo. Si otro
 * aparato que manda comanda vende uno de estos productos, sale «SIN ESTACIÓN»: el DASHBOARD lo dice en la nota del Ruteo.
 * ponytail: tampoco mira las PC que no emiten (la caja) ni la versión de la app (una vieja muestra todo).
 */

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { resolveDeviceMenuFilters } from '../devices/deviceMenus.service'

/** Pasado este número de PC que emiten, no se adivina: nada es «Sólo vale» y el Ruteo se ve como siempre. */
export const MAX_EMISORES = 50
const MAX_CATEGORIAS = 2000

export interface EmisorDeVales {
  areaId: string
  areaName: string
  sendsComanda: boolean
  /** Las categorías que muestra su cuadrícula; `null` = «Todos los menús». */
  visibles: ReadonlyArray<string> | null
}

export interface SoloVale {
  categoryIds: Set<string>
  /** Las áreas sin comanda que dejan al menos una categoría «Sólo vale», por nombre. */
  areas: Array<{ id: string; name: string }>
}

const nada = (): SoloVale => ({ categoryIds: new Set(), areas: [] })

export function clasificarSoloVale(emisores: ReadonlyArray<EmisorDeVales>, todas: ReadonlyArray<string>): SoloVale {
  const ve = (e: EmisorDeVales) => e.visibles ?? todas
  const conComanda = new Set(emisores.filter(e => e.sendsComanda).flatMap(ve))
  const categoryIds = new Set<string>()
  const areas = new Map<string, string>()
  for (const e of emisores) {
    if (e.sendsComanda) continue
    for (const id of ve(e)) {
      if (conComanda.has(id)) continue
      categoryIds.add(id)
      areas.set(e.areaId, e.areaName)
    }
  }
  return {
    categoryIds,
    areas: [...areas].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
  }
}

function leerEmisores(venueId: string) {
  return prisma.terminal.findMany({
    where: {
      venueId,
      // Lo que ANDROID exige para emitir (`issueWorkspace`): «Emitir», área activa y la pantalla de vales.
      canIssueAreaTickets: true,
      defaultWorkspace: 'AREA_OPERATIONS',
      status: { in: ['ACTIVE', 'MAINTENANCE'] },
      fulfillmentArea: { is: { venueId, active: true } },
    },
    select: { id: true, fulfillmentArea: { select: { id: true, name: true, sendsComanda: true } } },
    orderBy: { id: 'asc' },
    take: MAX_EMISORES + 1,
  })
}

/** Las categorías con algún producto activo: lo mismo que cuentan las apps para no dejar la cuadrícula en blanco. */
async function leerCategoriasConProductos(venueId: string): Promise<Set<string>> {
  const grupos = await prisma.product.groupBy({ by: ['categoryId'], where: { venueId, active: true, deletedAt: null }, _count: true })
  return new Set(grupos.flatMap(g => (g.categoryId ? [g.categoryId] : [])))
}

function leerCategoriasDelNegocio(venueId: string) {
  return prisma.menuCategory.findMany({ where: { venueId }, select: { id: true }, orderBy: { id: 'asc' }, take: MAX_CATEGORIAS + 1 })
}

export async function leerSoloVale(venueId: string): Promise<SoloVale> {
  // Primero el interruptor (casi ningún negocio usa vales: una sola lectura), luego el plan.
  const ajustes = await prisma.venueAreaTicketSettings.findUnique({ where: { venueId }, select: { enabled: true } })
  if (!ajustes?.enabled || !(await venueHasFeatureAccess(venueId, 'AREA_TICKETS'))) return nada()

  const filas = await leerEmisores(venueId)
  if (!filas.some(f => f.fulfillmentArea && !f.fulfillmentArea.sendsComanda)) return nada()
  if (filas.length > MAX_EMISORES) {
    logger.warn('[Ruteo] demasiadas PC que emiten vales: «Sólo vale» no se calcula', { venueId, emisores: filas.length })
    return nada()
  }

  const [porAparato, conProductos] = await Promise.all([
    resolveDeviceMenuFilters(
      venueId,
      filas.map(f => f.id),
    ),
    leerCategoriasConProductos(venueId),
  ])
  if (!porAparato) return nada()
  // Como ANDROID (`MenuDelAparato.filtroDeCobrar`): si ninguna categoría de su menú tiene productos activos, la PC enseña todo
  // el catálogo (nunca deja la cuadrícula en blanco). Codex r2 #1.
  const filtros = filas.map(f => {
    const visibles = porAparato.get(f.id)?.visibleCategoryIds ?? null
    return { visibleCategoryIds: visibles && visibles.some(id => conProductos.has(id)) ? visibles : null }
  })
  let todas: string[] = []
  if (filtros.some(f => f.visibleCategoryIds === null)) {
    const categorias = await leerCategoriasDelNegocio(venueId)
    if (categorias.length > MAX_CATEGORIAS) {
      logger.warn('[Ruteo] demasiadas categorías: «Sólo vale» no se calcula', { venueId })
      return nada()
    }
    todas = categorias.map(c => c.id)
  }

  const emisores: EmisorDeVales[] = filas.flatMap((f, i) =>
    f.fulfillmentArea
      ? [
          {
            areaId: f.fulfillmentArea.id,
            areaName: f.fulfillmentArea.name,
            sendsComanda: f.fulfillmentArea.sendsComanda,
            visibles: filtros[i].visibleCategoryIds,
          },
        ]
      : [],
  )
  return clasificarSoloVale(emisores, todas)
}
