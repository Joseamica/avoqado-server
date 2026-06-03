import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'

export function registerVenueTools(server: McpServer, scope: McpScope) {
  server.tool(
    'list_my_venues',
    'List the venues you can access in your active organization (id, name, slug, status, city).',
    {},
    async () => {
      const venues = await prisma.venue.findMany({
        where: { id: { in: scope.allowedVenueIds } },
        select: { id: true, name: true, slug: true, status: true, city: true },
        orderBy: { name: 'asc' },
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ count: venues.length, venues }, null, 2) }] }
    },
  )
}
