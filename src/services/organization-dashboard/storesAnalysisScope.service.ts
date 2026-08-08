import { StaffRole } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const ORGANIZATION_WIDE_ROLES = new Set<StaffRole>([StaffRole.SUPERADMIN, StaffRole.OWNER, StaffRole.ADMIN])

interface ResolveStoresAnalysisVenueIdsParams {
  organizationId: string
  userId: string
  role: StaffRole
  filterVenueId?: string
}

/**
 * Resolves the exact venue scope for organization analytics.
 *
 * `undefined` means every active venue in the organization. An empty array is
 * intentionally different: it means the caller has no active venue assignment.
 */
export async function resolveStoresAnalysisVenueIds({
  organizationId,
  userId,
  role,
  filterVenueId,
}: ResolveStoresAnalysisVenueIdsParams): Promise<string[] | undefined> {
  if (ORGANIZATION_WIDE_ROLES.has(role)) {
    if (!filterVenueId) return undefined

    const venue = await prisma.venue.findFirst({
      where: { id: filterVenueId, organizationId, status: 'ACTIVE' },
      select: { id: true },
    })

    if (!venue) {
      throw new ForbiddenError('No tienes acceso a esta sucursal')
    }

    return [venue.id]
  }

  const assignments = await prisma.staffVenue.findMany({
    where: {
      staffId: userId,
      active: true,
      venue: { organizationId, status: 'ACTIVE' },
    },
    select: { venueId: true },
  })
  const venueIds = assignments.map(assignment => assignment.venueId)

  if (filterVenueId && !venueIds.includes(filterVenueId)) {
    throw new ForbiddenError('No tienes acceso a esta sucursal')
  }

  return filterVenueId ? [filterVenueId] : venueIds
}
