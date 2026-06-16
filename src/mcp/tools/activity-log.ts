import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerActivityLogTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'get_activity_log',
    "Audit trail for your venue(s): who did what and when — orders (comp/void/discount), payments, refunds, shifts, staff/access changes, inventory receiving and SIM custody, config changes. Most recent first. Pass venueId to focus one venue; filter by action code or date range.",
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      action: z.string().optional().describe('Filter by exact action code, e.g. PAYMENT_COMPLETED or SIM_CUSTODY_ASSIGNED_TO_PROMOTER'),
      startDate: z.string().optional().describe('ISO date lower bound (inclusive)'),
      endDate: z.string().optional().describe('ISO date upper bound (inclusive)'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max rows'),
    },
    async ({ venueId, action, startDate, endDate, limit }) => {
      const where: Record<string, unknown> = { ...guard.venueFilter(venueId) }
      if (action) where.action = action
      if (startDate || endDate) {
        const createdAt: Record<string, Date> = {}
        if (startDate) createdAt.gte = new Date(startDate)
        if (endDate) createdAt.lte = new Date(endDate)
        where.createdAt = createdAt
      }
      const logs = await prisma.activityLog.findMany({
        where: where as any,
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          data: true,
          createdAt: true,
          venueId: true,
          staff: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return text({ count: logs.length, logs })
    },
  )
}
