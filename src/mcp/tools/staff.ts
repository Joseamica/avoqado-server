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

  server.tool(
    'staff_detail',
    'Detail of ONE team member of a venue you can access, found by name: their account status and the role they hold at EACH of your venues where they work. The drill-down after list_staff — answers "¿qué rol tiene Juan? ¿en qué locales trabaja? ¿está activo?". Does NOT expose contact details (email/phone). If the name matches several people it returns them so you can be specific. Pass venueId + name.',
    {
      venueId: z.string().describe('Venue to search within (must be in your scope)'),
      name: z.string().min(1).describe('Team member name or part of it'),
    },
    async ({ venueId, name }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const matches = await prisma.staffVenue.findMany({
        where: {
          ...base,
          staff: {
            OR: [
              { firstName: { contains: name, mode: 'insensitive' as const } },
              { lastName: { contains: name, mode: 'insensitive' as const } },
            ],
          },
        },
        select: { staffId: true, staff: { select: { firstName: true, lastName: true, active: true } } },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ found: false, error: `No encontré ningún miembro del equipo que coincida con "${name}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          found: false,
          ambiguous: true,
          error: `"${name}" coincide con varias personas — sé más específico.`,
          matches: matches.map(m => `${m.staff.firstName} ${m.staff.lastName}`.trim()),
        })
      }

      const m = matches[0]
      // The role they hold at each of the CALLER's venues (scope-limited — never reveals venues outside scope).
      const assignments = await prisma.staffVenue.findMany({
        where: { staffId: m.staffId, ...guard.venueFilter() },
        select: { role: true, venue: { select: { name: true } } },
        orderBy: { venue: { name: 'asc' } },
      })
      return text({
        found: true,
        staff: { name: `${m.staff.firstName} ${m.staff.lastName}`.trim(), active: m.staff.active },
        venues: assignments.map(a => ({ venue: a.venue?.name ?? null, role: a.role })),
      })
    },
  )
}
