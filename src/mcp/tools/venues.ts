import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerVenueTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_my_venues',
    'List the venues you can access (id, name, slug, status, city). The connection is bound to ONE active organization — if a venue the user mentions is NOT here, it may belong to another of their organizations: check list_my_organizations and tell them to reconnect choosing that org. NEVER substitute a different venue for one that is missing.',
    {},
    async () => {
      const [venues, orgName, otherOrgs] = await Promise.all([
        prisma.venue.findMany({
          where: { id: { in: scope.allowedVenueIds } },
          select: { id: true, name: true, slug: true, status: true, city: true },
          orderBy: { name: 'asc' },
        }),
        prisma.organization.findUnique({ where: { id: scope.activeOrg }, select: { name: true } }).then(o => o?.name ?? null),
        scope.isSuperAdmin
          ? Promise.resolve(0)
          : prisma.staffOrganization.count({ where: { staffId: scope.staffId, isActive: true, organizationId: { not: scope.activeOrg } } }),
      ])
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                count: venues.length,
                ...(scope.isSuperAdmin
                  ? { note: 'Conexión SUPERADMIN: acceso global a todas las organizaciones.' }
                  : {
                      activeOrganization: orgName,
                      ...(otherOrgs > 0
                        ? {
                            note: `El usuario pertenece a ${otherOrgs} organización(es) más que NO están en esta conexión. Si busca un venue que no aparece aquí, probablemente está en otra — sugiérele reconectar el conector eligiendo esa organización. No uses otro venue como sustituto.`,
                          }
                        : {}),
                    }),
                venues,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.tool(
    'venue_profile',
    "The basic profile / setup of a venue you can access: name, type, currency, timezone, language, address, contact (phone/email/website) and whether it is active. Handy to confirm configuration, and to give an assistant the venue's currency & timezone for formatting. Does NOT expose any fiscal, KYC or payment-credential data. Pass venueId.",
    {
      venueId: z.string().describe('Venue whose profile to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope (Venue is keyed by id, so the throw IS the gate)
      const v = await prisma.venue.findFirst({
        where: { id: venueId },
        select: {
          name: true,
          slug: true,
          type: true,
          timezone: true,
          currency: true,
          language: true,
          active: true,
          address: true,
          city: true,
          state: true,
          country: true,
          zipCode: true,
          phone: true,
          email: true,
          website: true,
        },
      })
      if (!v) return text({ found: false, error: 'Venue not found.' })
      return text({
        found: true,
        venueId,
        profile: {
          name: v.name,
          slug: v.slug,
          type: v.type,
          currency: v.currency,
          timezone: v.timezone,
          language: v.language,
          active: v.active,
          address: { line: v.address, city: v.city, state: v.state, country: v.country, zip: v.zipCode },
          contact: { phone: v.phone, email: v.email, website: v.website },
        },
      })
    },
  )
}
