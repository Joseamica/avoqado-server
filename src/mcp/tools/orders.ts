import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus, PaymentStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))

export function registerOrderTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'recent_orders',
    'Recent orders across your venues (or one venue): order number, type, status, total, venue, time. Most recent first. Pass venueId to focus one venue.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      limit: z.number().int().min(1).max(50).default(15).describe('Max orders to return'),
    },
    async ({ venueId, limit }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const orders = await prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          type: true,
          status: true,
          total: true,
          createdAt: true,
          venue: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return text({ count: orders.length, orders })
    },
  )

  server.tool(
    'find_order',
    'Find one order by its id, or by a serial number (SIM/ICCID/barcode) of an item sold on it. Returns the order header, line items, and payments — but only if the order belongs to one of your venues. Pass exactly one of orderId or serialNumber.',
    {
      orderId: z.string().optional().describe('The order id (cuid)'),
      serialNumber: z.string().optional().describe('A serial number / barcode / ICCID of an item sold on the order'),
    },
    async ({ orderId, serialNumber }) => {
      const where = guard.venueFilter() // {venueId:{in:[...]}} — enforces scope
      let id = orderId
      if (!id && serialNumber) {
        const item = await prisma.serializedItem.findFirst({
          where: { serialNumber },
          select: { orderItem: { select: { orderId: true } } },
        })
        id = item?.orderItem?.orderId ?? undefined
        if (!id) return text({ found: false, reason: `No order found for serial "${serialNumber}"` })
      }
      if (!id) return text({ found: false, reason: 'Pass orderId or serialNumber' })
      const order = await prisma.order.findFirst({
        where: { id, ...where }, // scope: null if the order is not one of your venues'
        select: {
          id: true,
          orderNumber: true,
          type: true,
          status: true,
          paymentStatus: true,
          total: true,
          createdAt: true,
          venue: { select: { name: true } },
          items: { select: { productName: true, quantity: true, unitPrice: true, total: true } },
          payments: { select: { amount: true, method: true, status: true, createdAt: true } },
        },
      })
      if (!order) return text({ found: false, reason: 'Order not found, or it is outside your venues' })
      return text({ found: true, order })
    },
  )

  server.tool(
    'open_orders',
    'Open / unpaid tabs RIGHT NOW across your venues (or one venue): orders still owing money (paymentStatus PENDING or PARTIAL, not cancelled) — table, covers, type, status, total, already paid, remaining balance, item count, and when it was opened. Oldest first (the tabs to chase). Plus the total still owed across all of them. Answers "¿qué cuentas tengo abiertas? ¿qué mesas no han pagado? ¿cuánto me deben ahorita?". Pass venueId to focus one venue.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      limit: z.number().int().min(1).max(50).default(25).describe('Max open orders to return (oldest first)'),
    },
    async ({ venueId, limit }) => {
      const where = {
        ...guard.venueFilter(venueId), // throws ScopeError if the venue is out of scope
        paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
      }
      const [summary, orders] = await Promise.all([
        prisma.order.aggregate({ where, _count: { _all: true }, _sum: { remainingBalance: true, total: true, paidAmount: true } }),
        prisma.order.findMany({
          where,
          select: {
            id: true,
            orderNumber: true,
            type: true,
            status: true,
            paymentStatus: true,
            total: true,
            paidAmount: true,
            remainingBalance: true,
            covers: true,
            createdAt: true,
            table: { select: { number: true } },
            venue: { select: { name: true } },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: 'asc' }, // oldest open first — the tabs to chase
          take: limit,
        }),
      ])
      return text({
        count: orders.length,
        outstanding: {
          openOrders: summary._count._all,
          totalOwed: num(summary._sum.remainingBalance), // what you're still owed across all open tabs
          grossTotal: num(summary._sum.total),
          alreadyPaid: num(summary._sum.paidAmount),
        },
        orders: orders.map(o => ({
          id: o.id,
          orderNumber: o.orderNumber,
          venue: o.venue?.name ?? null,
          table: o.table?.number ?? null,
          covers: o.covers,
          type: o.type,
          status: o.status,
          paymentStatus: o.paymentStatus, // PENDING | PARTIAL
          total: num(o.total),
          paid: num(o.paidAmount),
          balance: num(o.remainingBalance),
          items: o._count.items,
          openedAt: o.createdAt.toISOString(),
        })),
      })
    },
  )
}
