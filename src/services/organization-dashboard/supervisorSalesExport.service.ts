import { OrderStatus, Prisma, VenueStatus } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { DEFAULT_TIMEZONE, parseDbDateRange } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'

export const SUPERVISOR_SALES_EXPORT_PAGE_SIZE = 500
export const SUPERVISOR_SALES_EXPORT_MAX_ROWS = 25_000
export const SUPERVISOR_SALES_EXPORT_MAX_RANGE_DAYS = 370

const DAY_MS = 24 * 60 * 60 * 1000

export interface SupervisorSalesExportCursor {
  createdAt: string
  id: string
}

export interface SupervisorSalesExportRow {
  id: string
  venueName: string
  product: string
  iccid: string | null
  staffId: string | null
  staffName: string
  staffEmployeeCode: string | null
  amount: number
  timestamp: string
}

export interface SupervisorSalesExportPageInput {
  organizationId: string
  scopedVenueIds?: string[]
  startDate: string
  endDate: string
  timezone?: string
  cursor?: string
  limit?: number
}

export interface SupervisorSalesExportPage {
  rows: SupervisorSalesExportRow[]
  nextCursor: string | null
  total?: number
}

export function encodeSupervisorSalesExportCursor(cursor: SupervisorSalesExportCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeSupervisorSalesExportCursor(cursor: string): SupervisorSalesExportCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SupervisorSalesExportCursor>
    const parsedDate = typeof value.createdAt === 'string' ? new Date(value.createdAt) : null

    if (!parsedDate || Number.isNaN(parsedDate.getTime()) || typeof value.id !== 'string' || !value.id.trim()) {
      throw new Error('invalid cursor payload')
    }

    return { createdAt: parsedDate.toISOString(), id: value.id }
  } catch {
    throw new BadRequestError('El cursor de exportación no es válido')
  }
}

export function parseSupervisorSalesExportRange(
  startDate?: string,
  endDate?: string,
  timezone: string = DEFAULT_TIMEZONE,
): { from: Date; to: Date } {
  if (!startDate || !endDate) {
    throw new BadRequestError('startDate y endDate son requeridos para exportar')
  }

  const range = parseDbDateRange(startDate, endDate, timezone)
  if (range.to.getTime() < range.from.getTime()) {
    throw new BadRequestError('La fecha final debe ser posterior a la fecha inicial')
  }

  if (range.to.getTime() - range.from.getTime() > SUPERVISOR_SALES_EXPORT_MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestError(`El rango máximo de exportación es de ${SUPERVISOR_SALES_EXPORT_MAX_RANGE_DAYS} días`)
  }

  return range
}

export async function getSupervisorSalesExportPage(input: SupervisorSalesExportPageInput): Promise<SupervisorSalesExportPage> {
  const range = parseSupervisorSalesExportRange(input.startDate, input.endDate, input.timezone)
  const cursor = input.cursor ? decodeSupervisorSalesExportCursor(input.cursor) : undefined
  const requestedLimit =
    Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : SUPERVISOR_SALES_EXPORT_PAGE_SIZE
  const pageSize = Math.min(requestedLimit, SUPERVISOR_SALES_EXPORT_PAGE_SIZE)

  const where: Prisma.OrderWhereInput = {
    status: OrderStatus.COMPLETED,
    createdAt: { gte: range.from, lte: range.to },
    venue: { organizationId: input.organizationId, status: VenueStatus.ACTIVE },
    ...(input.scopedVenueIds !== undefined ? { venueId: { in: input.scopedVenueIds } } : {}),
    ...(cursor
      ? {
          AND: [
            {
              OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }],
            },
          ],
        }
      : {}),
  }

  let total: number | undefined
  if (!cursor) {
    total = await prisma.order.count({ where })
    if (total > SUPERVISOR_SALES_EXPORT_MAX_ROWS) {
      throw new BadRequestError(
        `La exportación contiene más de ${SUPERVISOR_SALES_EXPORT_MAX_ROWS.toLocaleString('en-US')} ventas; reduce el rango de fechas`,
      )
    }
  }

  const orders = await prisma.order.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: pageSize + 1,
    select: {
      id: true,
      createdAt: true,
      total: true,
      venue: { select: { name: true } },
      servedById: true,
      servedBy: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      items: {
        take: 1,
        orderBy: { sequence: 'asc' },
        select: { serializedItem: { select: { serialNumber: true } } },
      },
    },
  })

  const hasMore = orders.length > pageSize
  const pageOrders = hasMore ? orders.slice(0, pageSize) : orders
  const rows: SupervisorSalesExportRow[] = pageOrders.map(order => {
    const amount = Number(order.total)
    return {
      id: order.id,
      venueName: order.venue.name,
      product: `Venta: $${amount.toFixed(2)}`,
      iccid: order.items[0]?.serializedItem?.serialNumber ?? null,
      staffId: order.servedById ?? null,
      staffName: order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}`.trim() : 'Staff desconocido',
      staffEmployeeCode: order.servedBy?.employeeCode ?? null,
      amount,
      timestamp: order.createdAt.toISOString(),
    }
  })
  const lastOrder = pageOrders[pageOrders.length - 1]
  const nextCursor =
    hasMore && lastOrder ? encodeSupervisorSalesExportCursor({ createdAt: lastOrder.createdAt.toISOString(), id: lastOrder.id }) : null

  return {
    rows,
    nextCursor,
    ...(total !== undefined ? { total } : {}),
  }
}
