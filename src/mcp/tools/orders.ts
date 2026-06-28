import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus, OrderType, PaymentStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  pending: OrderStatus.PENDING,
  confirmed: OrderStatus.CONFIRMED,
  preparing: OrderStatus.PREPARING,
  ready: OrderStatus.READY,
  completed: OrderStatus.COMPLETED,
  cancelled: OrderStatus.CANCELLED,
  deleted: OrderStatus.DELETED,
}
const ORDER_TYPE_MAP: Record<string, OrderType> = {
  dine_in: OrderType.DINE_IN,
  takeout: OrderType.TAKEOUT,
  delivery: OrderType.DELIVERY,
  pickup: OrderType.PICKUP,
  manual_entry: OrderType.MANUAL_ENTRY,
}

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
    'Find one order by its human ORDER NUMBER (what the operator sees on receipts/screens, e.g. ORD-5454 or FAST-1781718731451), by its internal id, or by a serial number (SIM/ICCID/barcode) of an item sold on it. Returns the order header, line items, and payments — but only if the order belongs to one of your venues. Pass exactly one of orderNumber, orderId, or serialNumber. Prefer orderNumber — it is the identifier operators actually have.',
    {
      orderNumber: z.string().optional().describe('The human order number shown on receipts/screens (e.g. ORD-5454, FAST-1781718731451) — case-insensitive'),
      orderId: z.string().optional().describe('The internal order id (cuid) — operators rarely have this; prefer orderNumber'),
      serialNumber: z.string().optional().describe('A serial number / barcode / ICCID of an item sold on the order'),
    },
    async ({ orderNumber, orderId, serialNumber }) => {
      const where = guard.venueFilter() // {venueId:{in:[...]}} — enforces scope
      let id = orderId
      if (!id && orderNumber) {
        // Resolve the human order number → id WITHIN scope (so you can't probe another venue's numbers).
        // Case-insensitive; order numbers can repeat across venues, so take the most recent match.
        const trimmed = orderNumber.trim()
        const byNumber = await prisma.order.findFirst({
          where: { ...where, orderNumber: { equals: trimmed, mode: 'insensitive' as const } },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
        })
        id = byNumber?.id ?? undefined
        if (!id) return text({ found: false, reason: `No order found with number "${orderNumber}" in your venues` })
      }
      if (!id && serialNumber) {
        // Serials are stored canonically UPPERCASE, but a handful of legacy items are lower-cased —
        // match case-insensitively so a scan/paste in either case still resolves the order.
        const trimmed = serialNumber.trim()
        const serialVariants = Array.from(new Set([trimmed, trimmed.toUpperCase(), trimmed.toLowerCase()]))
        const item = await prisma.serializedItem.findFirst({
          where: { serialNumber: { in: serialVariants } },
          select: { orderItem: { select: { orderId: true } } },
        })
        id = item?.orderItem?.orderId ?? undefined
        if (!id) return text({ found: false, reason: `No order found for serial "${serialNumber}"` })
      }
      if (!id) return text({ found: false, reason: 'Pass orderNumber, orderId, or serialNumber' })
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

  server.tool(
    'search_orders',
    'Search orders across your venues (or one venue) with filters: by status (pending/preparing/completed/cancelled/…), type (dine-in/takeout/delivery/pickup/manual), and/or a date range (default last 7 days). Returns a summary (count + total) and the matching orders (number, venue, table, type, status, payment status, total, time), newest first. The flexible version of recent_orders — answers "¿cuántas órdenes canceladas ayer? ¿pedidos a domicilio de hoy? ¿órdenes de la semana?". Pass venueId to focus one venue; optionally status, type, fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      status: z
        .enum(['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'deleted', 'all'])
        .optional()
        .describe("Filter by order status (default 'all')"),
      type: z
        .enum(['dine_in', 'takeout', 'delivery', 'pickup', 'manual_entry', 'all'])
        .optional()
        .describe("Filter by order type (default 'all')"),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max orders to list (newest first)'),
    },
    async ({ venueId, status, type, fromDate, toDate, limit }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      let tz = 'America/Mexico_City'
      if (venueId) {
        const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
        tz = venue?.timezone || tz
      }
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const where = {
        ...base,
        createdAt: { gte: start, lte: end },
        ...(status && status !== 'all' ? { status: ORDER_STATUS_MAP[status] } : {}),
        ...(type && type !== 'all' ? { type: ORDER_TYPE_MAP[type] } : {}),
      }

      const [summary, orders] = await Promise.all([
        prisma.order.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
        prisma.order.findMany({
          where,
          select: {
            orderNumber: true,
            type: true,
            status: true,
            paymentStatus: true,
            total: true,
            createdAt: true,
            venue: { select: { name: true } },
            table: { select: { number: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      ])

      return text({
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        summary: { count: summary._count._all, total: num(summary._sum.total) },
        shown: orders.length,
        orders: orders.map(o => ({
          orderNumber: o.orderNumber,
          venue: o.venue?.name ?? null,
          table: o.table?.number ?? null,
          type: o.type,
          status: o.status,
          paymentStatus: o.paymentStatus,
          total: num(o.total),
          at: o.createdAt.toISOString(),
        })),
      })
    },
  )
}
