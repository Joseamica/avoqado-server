import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerReservationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'reservations',
    'Reservations across your venues (or one venue): when, party size, guest, status, confirmation code. Upcoming only by default, soonest first. Pass venueId to focus one venue; pass includePast to also see recent reservations that already started.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      includePast: z.boolean().default(false).describe('Include reservations that already started (default: only upcoming)'),
      limit: z.number().int().min(1).max(50).default(15).describe('Max reservations to return'),
    },
    async ({ venueId, includePast, limit }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const timeFilter = includePast ? {} : { startsAt: { gte: new Date() } }
      const reservations = await prisma.reservation.findMany({
        where: { ...where, ...timeFilter },
        select: {
          id: true,
          confirmationCode: true,
          status: true,
          startsAt: true,
          partySize: true,
          guestName: true,
          guestPhone: true,
          venue: { select: { name: true } },
        },
        orderBy: { startsAt: includePast ? 'desc' : 'asc' },
        take: limit,
      })
      return text({ count: reservations.length, upcoming: !includePast, reservations })
    },
  )
}
