import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { normalizeGoogleReviewUrl } from '@/utils/googleReviewLink'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerVenueTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_my_venues',
    'Lista paginada de sucursales accesibles, con el rol y permisos efectivos en CADA una, moneda y zona horaria. Usa search para resolver un nombre ambiguo; hasMore/nextOffset permiten continuar. No confundas una página con todos los locales. La conexión corresponde a una organización activa; sólo después de buscar comprueba list_my_organizations si falta un local. Nunca sustituyas la sucursal solicitada.',
    {
      search: z.string().trim().max(200).optional().describe('Buscar por nombre, slug o ciudad'),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async ({ search, limit = 50, offset = 0 }) => {
      const where = {
        id: { in: scope.allowedVenueIds },
        ...(search
          ? {
              OR: ['name', 'slug', 'city'].map(field => ({ [field]: { contains: search, mode: 'insensitive' as const } })),
            }
          : {}),
      }
      const [venues, total, orgName, otherOrgs] = await Promise.all([
        prisma.venue.findMany({
          where,
          select: { id: true, name: true, slug: true, status: true, city: true, currency: true, timezone: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: limit,
          skip: offset,
        }),
        prisma.venue.count({ where }),
        prisma.organization.findUnique({ where: { id: scope.activeOrg }, select: { name: true } }).then(o => o?.name ?? null),
        scope.isSuperAdmin
          ? Promise.resolve(0)
          : prisma.staffOrganization.count({
              where: { staffId: scope.staffId, isActive: true, leftAt: null, organizationId: { not: scope.activeOrg } },
            }),
      ])
      const hasMore = offset + venues.length < total
      return text({
        count: venues.length,
        total,
        hasMore,
        nextOffset: hasMore ? offset + venues.length : null,
        activeOrganization: orgName,
        organizationId: scope.activeOrg,
        organizationRole: scope.orgRole ?? null,
        connectionScopes: scope.scopes ?? ['mcp:read'],
        permissionNote:
          'Los permisos son propios de cada sucursal. La conexión, el plan y la activación del módulo también se comprueban en cada operación.',
        ...(scope.isSuperAdmin
          ? { note: 'Conexión SUPERADMIN: acceso global a todas las organizaciones.' }
          : otherOrgs > 0
            ? {
                note: `El usuario pertenece a ${otherOrgs} organización(es) más que NO están en esta conexión. Busca por nombre o recorre las páginas antes de concluir que falta un venue. Si está en otra organización, reconecta eligiéndola. No uses otro venue como sustituto.`,
              }
            : {}),
        venues: venues.map(v => ({
          ...v,
          role: scope.perVenueAccess.get(v.id)?.role ?? null,
          permissions: scope.perVenueAccess.get(v.id)?.corePermissions ?? [],
        })),
      })
    },
  )

  server.tool(
    'venue_profile',
    "The basic profile / setup of a venue you can access: name, type, currency, timezone, language, address, contact (phone/email/website) and whether it is active. Handy to confirm configuration, and to give an assistant the venue's currency & timezone for formatting. Does NOT expose any fiscal, KYC or payment-credential data. Pass venueId. For OWNER connections it also includes reviews.googleReviewUrl (the venue's Google-review redirect link).",
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

      // OWNER-only: expose the venue's Google-review redirect link. Roles differ
      // per venue, so read this venue's role from scope (never a global role).
      const role = scope.perVenueAccess.get(venueId)?.role
      const isOwnerLevel = role === 'OWNER' || role === 'SUPERADMIN'
      let googleReviewUrl: string | null = null
      if (isOwnerLevel) {
        const settings = await prisma.venueSettings.findUnique({
          where: { venueId },
          select: { googleReviewLink: true },
        })
        googleReviewUrl = normalizeGoogleReviewUrl(settings?.googleReviewLink)
      }

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
          ...(isOwnerLevel ? { reviews: { googleReviewUrl } } : {}),
        },
      })
    },
  )
}
