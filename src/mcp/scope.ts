import prisma from '@/utils/prismaClient'
import { getUserAccess, createAccessCache } from '@/services/access/access.service'
import type { UserAccess } from '@/services/access/access.service'

export interface McpScope {
  staffId: string
  activeOrg: string
  allowedVenueIds: string[]
  perVenueAccess: Map<string, UserAccess>
}

/**
 * What a connected Staff may touch in their active org.
 *   org-level OWNER (OrgRole.OWNER)   -> ALL venues in the org
 *   ADMIN / MEMBER / VIEWER (OrgRole) -> only their StaffVenue assignments in this org
 * Permissions resolved per venue (roles can differ per venue).
 */
export async function resolveScope(staffId: string, activeOrg: string): Promise<McpScope> {
  const empty: McpScope = { staffId, activeOrg, allowedVenueIds: [], perVenueAccess: new Map() }
  const membership = await prisma.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId: activeOrg } },
    select: { role: true, isActive: true },
  })
  if (!membership || !membership.isActive) return empty

  let venueIds: string[]
  if (membership.role === 'OWNER') {
    const venues = await prisma.venue.findMany({ where: { organizationId: activeOrg }, select: { id: true } })
    venueIds = venues.map(v => v.id)
  } else {
    const assignments = await prisma.staffVenue.findMany({
      where: { staffId, venue: { organizationId: activeOrg } },
      select: { venueId: true },
    })
    venueIds = assignments.map(a => a.venueId)
  }

  const cache = createAccessCache()
  const perVenueAccess = new Map<string, UserAccess>()
  for (const venueId of venueIds) {
    try {
      perVenueAccess.set(venueId, await getUserAccess(staffId, venueId, cache))
    } catch {
      // getUserAccess throws when the staff has no access to that venue — skip defensively.
    }
  }
  return { staffId, activeOrg, allowedVenueIds: [...perVenueAccess.keys()], perVenueAccess }
}
