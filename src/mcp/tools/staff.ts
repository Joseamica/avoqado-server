import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerStaffTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_staff',
    'List the team (roster) of a venue you can access: each member\'s name, role and whether their account is active. Optionally filter by name or only active members. Pass venueId. Answers "who works here / who is on my team?". For sales performance use staff_ranking instead.',
    {
      venueId: z.string().describe('Venue whose team to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by name (partial, case-insensitive)'),
      activeOnly: z.boolean().optional().describe('Only active accounts'),
      limit: z.number().int().positive().max(200).optional().describe('Max members to return (default 200)'),
    },
    async ({ venueId, search, activeOnly, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const rows = await prisma.staffVenue.findMany({
        where: {
          ...where,
          ...(activeOnly || search
            ? {
                staff: {
                  ...(activeOnly ? { active: true } : {}),
                  ...(search
                    ? {
                        OR: [
                          { firstName: { contains: search, mode: 'insensitive' as const } },
                          { lastName: { contains: search, mode: 'insensitive' as const } },
                        ],
                      }
                    : {}),
                },
              }
            : {}),
        },
        select: { role: true, staff: { select: { firstName: true, lastName: true, active: true } } },
        orderBy: [{ role: 'asc' }, { staff: { firstName: 'asc' } }],
        take: limit ?? 200,
      })
      return text({
        venueId,
        count: rows.length,
        staff: rows.map(r => ({ name: `${r.staff.firstName} ${r.staff.lastName}`.trim(), role: r.role, active: r.staff.active })),
      })
    },
  )
}
