import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { hasPermission } from '@/services/access/access.service'

export function registerActivityLogTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'get_activity_log',
    'Audit trail for your venue(s): who did what and when — orders (comp/void/discount), payments, refunds, shifts, staff/access changes, inventory receiving and SIM custody, config changes. Most recent first. Pass venueId to focus one venue; filter by action code or date range. Requires the activity:read permission (owner-level).',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      action: z.string().optional().describe('Filter by exact action code, e.g. PAYMENT_COMPLETED or SIM_CUSTODY_ASSIGNED_TO_PROMOTER'),
      startDate: z.string().optional().describe('ISO date lower bound (inclusive), venue-local'),
      endDate: z.string().optional().describe('ISO date upper bound (inclusive), venue-local'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max rows'),
    },
    async ({ venueId, action, startDate, endDate, limit }) => {
      // Owner-only: enforce activity:read PER VENUE (mirror the dashboard endpoint gate).
      // Venue-scope isolation alone is not enough — a non-owner staff in scope must not read the audit trail.
      let venueIds: string[]
      if (venueId) {
        guard.requirePermission('activity:read', venueId) // throws if out of scope OR lacking the permission
        venueIds = [venueId]
      } else {
        venueIds = scope.allowedVenueIds.filter(v => {
          const access = scope.perVenueAccess.get(v)
          return !!access && hasPermission(access, 'activity:read')
        })
        if (venueIds.length === 0) return text({ count: 0, logs: [] })
      }

      const where: Record<string, unknown> = { venueId: { in: venueIds } }
      if (action) where.action = action
      if (startDate || endDate) {
        // Parse bare YYYY-MM-DD in the platform tz (STRING, not new Date()) so the day range is
        // host-tz-independent (prod runs UTC). See critical-warnings.md timezone trap.
        const tz = 'America/Mexico_City'
        const createdAt: Record<string, Date> = {}
        if (startDate) createdAt.gte = fromZonedTime(`${startDate}T00:00:00.000`, tz)
        if (endDate) createdAt.lte = fromZonedTime(`${endDate}T23:59:59.999`, tz)
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
