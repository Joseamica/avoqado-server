// src/services/dashboard/descuentosAplicados.service.ts
//
// Reporte «Descuentos» del DASHBOARD y tool `list_applied_discounts` del MCP (encargo f998c8, founder «A» 15-nov, como el «Discount
// Reasons» de Toast): qué descuentos se dieron en un periodo, agrupados por MOTIVO, y la lista paginada con su motivo y comentario.
//
// Capacidad (bounded-queries): el periodo se filtra por la fecha de la VENTA (índice `Order(venueId, createdAt)`), el agrupado es un
// `groupBy` en la base (exacto, no la suma de la página), la lista lleva tope del servidor y orden estable (`createdAt`, `id`), y el
// total de filas viaja siempre. Sólo cuentas vivas: una cancelada o borrada no dio el descuento (igual que `getDiscountStats`).
import type { OrderStatus, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { parseDbDateRange } from '../../utils/datetime'
import { NotFoundError } from '../../errors/AppError'

export const SIN_MOTIVO = '__SIN_MOTIVO__'
export const PAGINA_POR_DEFECTO = 50
export const PAGINA_MAXIMA = 100
/** Los motivos distintos que se agrupan. La lista del negocio tiene tope 30; lo demás sería texto viejo o de otra app. */
export const MOTIVOS_MAXIMOS = 100

export interface FiltrosDeDescuentosAplicados {
  from?: string
  to?: string
  page?: number
  pageSize?: number
  /** Un motivo exacto, o `SIN_MOTIVO` para los que llegaron sin motivo. */
  reason?: string
}

export interface DescuentoAplicado {
  id: string
  createdAt: Date
  orderId: string
  orderNumber: string | null
  name: string
  type: string
  amount: number
  reason: string | null
  reasonComment: string | null
  appliedBy: string | null
  authorizedBy: string | null
}

export interface ReporteDeDescuentosAplicados {
  from: Date
  to: Date
  totales: { count: number; amount: number }
  porMotivo: Array<{ reason: string | null; count: number; amount: number }>
  /** true si había más motivos distintos de los que se agruparon (nunca con la lista del negocio). */
  motivosRecortados: boolean
  rows: DescuentoAplicado[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

const nombre = (sv: { staff: { firstName: string | null; lastName: string | null } | null } | null): string | null => {
  if (!sv?.staff) return null
  const completo = [sv.staff.firstName, sv.staff.lastName].filter(Boolean).join(' ').trim()
  return completo || null
}

const redondear = (n: number) => Math.round(n * 100) / 100

export async function listarDescuentosAplicados(
  venueId: string,
  filtros: FiltrosDeDescuentosAplicados = {},
): Promise<ReporteDeDescuentosAplicados> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) throw new NotFoundError('No encontramos ese negocio.')
  // Sin fechas: los últimos 30 días del negocio (incluido hoy).
  const { from, to } = parseDbDateRange(filtros.from, filtros.to, venue.timezone, 30)

  const pageSize = Math.min(PAGINA_MAXIMA, Math.max(1, Math.trunc(filtros.pageSize ?? PAGINA_POR_DEFECTO) || PAGINA_POR_DEFECTO))
  const page = Math.max(1, Math.trunc(filtros.page ?? 1) || 1)

  const delPeriodo = {
    order: {
      venueId,
      status: { notIn: ['CANCELLED', 'DELETED'] as OrderStatus[] },
      createdAt: { gte: from, lte: to },
    },
  } satisfies Prisma.OrderDiscountWhereInput
  const filtroDeMotivo: Prisma.OrderDiscountWhereInput =
    filtros.reason === undefined || filtros.reason === '' ? {} : { reason: filtros.reason === SIN_MOTIVO ? null : filtros.reason }
  const dondeLista = { ...delPeriodo, ...filtroDeMotivo }

  const [totales, grupos, total, filas] = await Promise.all([
    prisma.orderDiscount.aggregate({ where: delPeriodo, _count: { _all: true }, _sum: { amount: true } }),
    prisma.orderDiscount.groupBy({
      by: ['reason'],
      where: delPeriodo,
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ _sum: { amount: 'desc' } }, { reason: 'asc' }],
      take: MOTIVOS_MAXIMOS + 1,
    }),
    prisma.orderDiscount.count({ where: dondeLista }),
    prisma.orderDiscount.findMany({
      where: dondeLista,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        createdAt: true,
        orderId: true,
        name: true,
        type: true,
        amount: true,
        reason: true,
        reasonComment: true,
        order: { select: { orderNumber: true } },
        appliedBy: { select: { staff: { select: { firstName: true, lastName: true } } } },
        authorizedBy: { select: { staff: { select: { firstName: true, lastName: true } } } },
      },
    }),
  ])

  return {
    from,
    to,
    totales: { count: totales._count._all, amount: redondear(Number(totales._sum.amount ?? 0)) },
    porMotivo: grupos.slice(0, MOTIVOS_MAXIMOS).map(g => ({
      reason: g.reason,
      count: g._count._all,
      amount: redondear(Number(g._sum.amount ?? 0)),
    })),
    motivosRecortados: grupos.length > MOTIVOS_MAXIMOS,
    rows: filas.map(f => ({
      id: f.id,
      createdAt: f.createdAt,
      orderId: f.orderId,
      orderNumber: f.order?.orderNumber ?? null,
      name: f.name,
      type: f.type,
      amount: Number(f.amount),
      reason: f.reason,
      reasonComment: f.reasonComment,
      appliedBy: nombre(f.appliedBy),
      authorizedBy: nombre(f.authorizedBy),
    })),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  }
}
