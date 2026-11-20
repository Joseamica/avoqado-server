import { OrderStatus, PaymentStatus, type OrderType, type Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

/**
 * «Cuenta abierta»: la que todavía debe (`paymentStatus` PENDING o PARTIAL) y no se canceló ni se borró. Es la definición del tool
 * `open_orders` del MCP, y la B (C3) usa la misma; con `since`, sólo las que se abrieron desde esa hora.
 * 🔴 `open_orders` está en el directorio certificado (tanda `lecturas`, `src/mcp/directory/catalog.ts:87`): cambiar este filtro cambia
 * una tool que ya revisaron Claude y OpenAI.
 */
export function openOrdersWhere(venueIds: string[], since?: Date): Prisma.OrderWhereInput {
  return {
    venueId: { in: venueIds },
    paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
    status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
    ...(since ? { createdAt: { gte: since } } : {}),
  }
}

/** Una cuenta abierta, sin montos: cuándo se abrió, su tipo y su número de mesa (null sin mesa). */
export type OpenOrderBrief = { createdAt: Date; type: OrderType; tableNumber: string | null }
export type OpenOrdersBrief = { total: number; orders: OpenOrderBrief[] }

/** El servidor pone el tope: la B pide `SupportDataConfig.rows` (a lo más 5). */
const MAX_TAKE = 50

/**
 * Las cuentas abiertas de UNA sucursal desde `since`, de la más vieja a la más nueva, y cuántas son en total (contadas en la base,
 * antes del tope). Sin montos: sólo cuándo se abrió, el tipo y el número de mesa. Índice: `Order_venueId_createdAt_idx`.
 */
export async function listOpenOrdersBrief(venueId: string, since: Date, take: number): Promise<OpenOrdersBrief> {
  const where = openOrdersWhere([venueId], since)
  const [total, rows] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      select: { createdAt: true, type: true, table: { select: { number: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(1, Math.trunc(take) || 1), MAX_TAKE),
    }),
  ])
  return { total, orders: rows.map(o => ({ createdAt: o.createdAt, type: o.type, tableNumber: o.table?.number ?? null })) }
}
