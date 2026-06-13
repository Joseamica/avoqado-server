import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getUserAccess, createAccessCache } from '@/services/access/access.service'
import type { UserAccess } from '@/services/access/access.service'

export interface McpScope {
  staffId: string
  activeOrg: string
  allowedVenueIds: string[]
  perVenueAccess: Map<string, UserAccess>
  /** Platform SUPERADMIN connection (global access — mirrors getUserAccess's bypass). */
  isSuperAdmin?: boolean
}

/**
 * What a connected Staff may touch in their active org.
 *   platform SUPERADMIN (any StaffVenue with role SUPERADMIN — same rule as getUserAccess)
 *                                          -> ALL venues, ALL orgs (founder: "solo si hago
 *                                             login con superadmin entonces sí podría")
 *   org-level OWNER (OrgRole.OWNER)        -> ALL venues in the org
 *   ADMIN / MEMBER / VIEWER (OrgRole)      -> only their StaffVenue assignments in this org
 *   no org membership, but has StaffVenue  -> only their assignments (venue-level owner/staff, e.g. Mindform)
 *   org membership deactivated             -> nothing (access revoked)
 * Permissions resolved per venue (getUserAccess is the final authority; roles can differ per venue).
 */
export async function resolveScope(staffId: string, activeOrg: string): Promise<McpScope> {
  // Platform SUPERADMIN → global scope. Synthesized wildcard access per venue (hasPermission
  // short-circuits on role SUPERADMIN) instead of 61× getUserAccess — resolveScope runs per request.
  const superAdminVenue = await prisma.staffVenue.findFirst({
    where: { staffId, role: StaffRole.SUPERADMIN },
    select: { id: true },
  })
  if (superAdminVenue) {
    const venues = await prisma.venue.findMany({ select: { id: true, organizationId: true } })
    const perVenueAccess = new Map<string, UserAccess>()
    for (const v of venues) {
      perVenueAccess.set(v.id, {
        userId: staffId,
        venueId: v.id,
        organizationId: v.organizationId,
        role: StaffRole.SUPERADMIN,
        corePermissions: ['*:*'],
        whiteLabelEnabled: false,
        enabledFeatures: [],
        featureAccess: {},
        featureMetadata: {},
      })
    }
    return { staffId, activeOrg, allowedVenueIds: venues.map(v => v.id), perVenueAccess, isSuperAdmin: true }
  }

  const membership = await prisma.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId: activeOrg } },
    select: { role: true, isActive: true },
  })
  // An org membership that exists but is deactivated = access revoked → nothing.
  if (membership && !membership.isActive) {
    return { staffId, activeOrg, allowedVenueIds: [], perVenueAccess: new Map() }
  }

  let venueIds: string[]
  if (membership?.role === 'OWNER') {
    // Org-level OWNER → every venue in the org.
    const venues = await prisma.venue.findMany({ where: { organizationId: activeOrg }, select: { id: true } })
    venueIds = venues.map(v => v.id)
  } else {
    // Active ADMIN/MEMBER/VIEWER, OR no org membership at all (venue-level owner/staff with
    // StaffVenue access but no StaffOrganization row, e.g. the Mindform owner) → only their
    // assignments in this org. getUserAccess below is the final per-venue authority.
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
