import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerCustomerTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'find_customer',
    'Find customers of a venue you can access by name, email or phone (partial, case-insensitive), OR omit the search term to list your top customers by total spent. Returns each with visits, total spent, loyalty points, tags (e.g. VIP), and contact — ranked by total spent. Answers "busca al cliente X / ¿es VIP? / ¿cuánto ha gastado?" and "¿quiénes son mis mejores clientes?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose customers to search (must be in your scope)'),
      search: z.string().optional().describe('Name, email or phone (partial). Omit to list your top customers by spend.'),
      limit: z.number().int().positive().max(25).optional().describe('Max results (default 10)'),
    },
    async ({ venueId, search, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const customers = await prisma.customer.findMany({
        where: {
          ...where,
          ...(search
            ? {
                OR: [
                  { firstName: { contains: search, mode: 'insensitive' as const } },
                  { lastName: { contains: search, mode: 'insensitive' as const } },
                  { email: { contains: search, mode: 'insensitive' as const } },
                  { phone: { contains: search } },
                ],
              }
            : {}),
        },
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          totalVisits: true,
          totalSpent: true,
          loyaltyPoints: true,
          tags: true,
          createdAt: true,
        },
        orderBy: { totalSpent: 'desc' },
        take: limit ?? 10,
      })
      return text({
        venueId,
        count: customers.length,
        customers: customers.map(c => ({
          name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null,
          email: c.email,
          phone: c.phone,
          visits: c.totalVisits,
          totalSpent: Number(c.totalSpent),
          loyaltyPoints: c.loyaltyPoints,
          tags: c.tags,
          since: c.createdAt.toISOString(),
        })),
      })
    },
  )
}
