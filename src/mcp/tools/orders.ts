import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

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
}
