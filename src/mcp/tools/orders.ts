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
}
