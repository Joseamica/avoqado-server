/**
 * Lectura de conteos físicos para AUDITORÍA (dashboard). Sólo lectura + cancelar.
 *
 * Acotada por diseño (bounded-queries-and-server-load.md): paginación en la
 * base con orden estable, tope por página impuesto aquí (no por el cliente), y
 * el resumen de cada conteo —la regla única de shared/stockCountSummary— se
 * calcula sólo con las líneas de los conteos de la página. Antes, el
 * controlador cargaba TODOS los conteos del venue con TODAS sus líneas y
 * paginaba en memoria.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { mapCountItem } from '../mobile/inventory.mobile.service'
import {
  estadoParaClientes,
  resumirConteo,
  type EstadoParaClientes,
  type LineaDeConteo,
  type ResumenDeConteo,
} from '../shared/stockCountSummary'

export const STOCK_COUNT_PAGE_MAX = 100
const STOCK_COUNT_PAGE_DEFAULT = 50
/** `skip` viaja a Postgres como Int de 32 bits: pasarse revienta la consulta. */
const MAX_SKIP = 2_147_483_647

export interface StockCountAuditFilters {
  status?: EstadoParaClientes
  type?: 'CYCLE' | 'FULL'
  startDate?: Date
  endDate?: Date
  page?: number
  pageSize?: number
}

export interface StockCountAuditRow {
  id: string
  type: string
  status: EstadoParaClientes
  note: string | null
  createdAt: string
  completedAt: string | null
  cancelledAt: string | null
  createdBy: string | null
  itemCount: number
  summary: ResumenDeConteo
  /** @deprecated Mezcla unidades. Sólo líneas contadas. Los clientes nuevos leen `summary`. */
  totalDifference: number
}

export type StockCountAuditDetail = StockCountAuditRow & { items: ReturnType<typeof mapCountItem>[] }

const LINEA_SELECT = {
  stockCountId: true,
  expected: true,
  counted: true,
  countedAt: true,
  rawMaterial: { select: { unit: true } },
} as const

function aLinea(l: {
  expected: Prisma.Decimal
  counted: Prisma.Decimal
  countedAt: Date | null
  rawMaterial: { unit: string } | null
}): LineaDeConteo {
  return { expected: l.expected, counted: l.counted, countedAt: l.countedAt, unit: l.rawMaterial?.unit ?? null }
}

function cabeceraAlWire(
  c: {
    id: string
    type: string
    status: string
    note: string | null
    createdAt: Date
    completedAt: Date | null
    cancelledAt: Date | null
    createdByUser: { firstName: string; lastName: string } | null
  },
  summary: ResumenDeConteo,
): StockCountAuditRow {
  return {
    id: c.id,
    type: c.type,
    status: estadoParaClientes(c.status),
    note: c.note,
    createdAt: c.createdAt.toISOString(),
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    cancelledAt: c.cancelledAt ? c.cancelledAt.toISOString() : null,
    createdBy: c.createdByUser ? `${c.createdByUser.firstName} ${c.createdByUser.lastName}` : null,
    itemCount: summary.itemCount,
    summary,
    totalDifference: summary.differenceByUnit.reduce((s, d) => s + d.difference, 0),
  }
}

/**
 * Un entero utilizable, o el default. Recortar NO basta: el controlador entrega
 * `parseInt('abc')` = NaN para `?page=abc` (y `?page[a]=1` llega como
 * `[object Object]`), y `Math.max(1, NaN)` sigue siendo NaN — un `skip: NaN`
 * viaja a Prisma y revienta la consulta con un 500, o sea que la única función
 * cuyo trabajo es «el cliente no puede dejar esto sin tope» la dejaba sin tope.
 * Todo lo que no sea finito (NaN, ±Infinity, ausente) cae al default; el
 * recorte de rango lo pone quien llama.
 */
function enteroFinito(valor: number | undefined, porDefecto: number): number {
  const n = Math.floor(Number(valor))
  return Number.isFinite(n) ? n : porDefecto
}

export async function listStockCountsForAudit(venueId: string, filters: StockCountAuditFilters) {
  // El piso es 1: un `take: 0` devolvería una página vacía sobre un total que no lo es.
  const pageSize = Math.min(STOCK_COUNT_PAGE_MAX, Math.max(1, enteroFinito(filters.pageSize, STOCK_COUNT_PAGE_DEFAULT)))
  // 🔴 El tope de `page` NO lo cubre el clamp de arriba: `999999999` es perfectamente
  // finito, y con él `skip` sale ≈ 5e10 — fuera del Int de 32 bits de Postgres, o sea un
  // 500 disparado desde un parámetro de la URL. Es la misma familia que el NaN, sólo que
  // por arriba. Va DESPUÉS del recorte de `pageSize` porque el tope depende de él.
  const page = Math.min(Math.max(1, enteroFinito(filters.page, 1)), Math.floor(MAX_SKIP / pageSize) + 1)

  const where = {
    venueId,
    // El cliente ve IN_PROGRESS; en la base un APPLYING (confirm en vuelo) también lo es.
    ...(filters.status
      ? { status: filters.status === 'IN_PROGRESS' ? { in: ['IN_PROGRESS' as const, 'APPLYING' as const] } : filters.status }
      : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.startDate || filters.endDate
      ? { createdAt: { ...(filters.startDate ? { gte: filters.startDate } : {}), ...(filters.endDate ? { lte: filters.endDate } : {}) } }
      : {}),
  }

  const [cabeceras, total] = await Promise.all([
    prisma.stockCount.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        status: true,
        note: true,
        createdAt: true,
        completedAt: true,
        cancelledAt: true,
        createdByUser: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.stockCount.count({ where }),
  ])

  const ids = cabeceras.map(c => c.id)
  // Sólo las líneas de ESTA página, y sólo las 4 columnas que el resumen necesita.
  const lineas =
    ids.length === 0 ? [] : await prisma.stockCountItem.findMany({ where: { stockCountId: { in: ids } }, select: LINEA_SELECT })
  const porConteo = new Map<string, LineaDeConteo[]>()
  for (const l of lineas) {
    const lista = porConteo.get(l.stockCountId) ?? []
    lista.push(aLinea(l))
    porConteo.set(l.stockCountId, lista)
  }

  const rows = cabeceras.map(c => cabeceraAlWire(c, resumirConteo(porConteo.get(c.id) ?? [])))
  return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
}

export async function getStockCountForAudit(venueId: string, countId: string): Promise<StockCountAuditDetail | null> {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, venueId },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, gtin: true, imageUrl: true } },
          rawMaterial: { select: { id: true, name: true, sku: true, gtin: true, unit: true } },
        },
      },
      createdByUser: { select: { firstName: true, lastName: true } },
    },
  })
  if (!count) return null
  // El MISMO mapeo que la lista (`aLinea`): si se escribiera dos veces, el resumen
  // del detalle y el de la lista podrían divergir al editar sólo uno.
  const summary = resumirConteo(count.items.map(aLinea))
  return { ...cabeceraAlWire(count, summary), items: count.items.map(mapCountItem) }
}
