import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { text } from '../respond'

export function registerOrganizationTools(server: McpServer, scope: McpScope) {
  server.tool(
    'list_my_organizations',
    'The organizations you belong to and which ONE this connection is scoped to. Each connection is bound to a single active organization; the others are listed here so you know they exist — to act on a different one, reconnect choosing that org. Returns each org with your role there, whether it is your primary, and whether it is the one currently connected. Answers "¿qué organizaciones tengo? ¿a cuál estoy conectado?". No arguments.',
    {},
    async () => {
      // Self-data: only the caller's own active memberships — inherently scoped to scope.staffId, no venue filter applies.
      const memberships = await prisma.staffOrganization.findMany({
        where: { staffId: scope.staffId, isActive: true },
        select: { role: true, isPrimary: true, organization: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
      })
      return text({
        connectedOrgId: scope.activeOrg,
        count: memberships.length,
        organizations: memberships.map(m => ({
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          yourRole: m.role,
          isPrimary: m.isPrimary,
          connected: m.organization.id === scope.activeOrg, // the org THIS connection can read/act on
        })),
      })
    },
  )
}
