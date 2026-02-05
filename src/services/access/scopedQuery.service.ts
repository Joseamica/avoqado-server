/**
 * Scoped Query Service
 *
 * Provides functions to apply data scope filtering for white-label features.
 * This ensures controllers respect the dataScope configured in feature access.
 *
 * Data Scopes:
 * - 'venue': Only data from the current venue
 * - 'user-venues': Data from all venues the user has access to
 * - 'organization': Data from all venues in the organization (OWNER only)
 *
 * IMPORTANT: This service does NOT depend on req object.
 * All parameters are passed explicitly for better testability and decoupling.
 *
 * @see docs/PERMISSIONS_SYSTEM.md for architecture details
 */
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import logger from '@/config/logger'

/**
 * Minimal venue info returned by scoped queries
 */
export interface ScopedVenue {
  id: string
  slug: string
  name: string
  organizationId: string
}

export type DataScope = 'venue' | 'user-venues' | 'organization'

/**
 * Access info needed for scoped queries
 * Can be extracted from UserAccess or provided directly
 */
export interface ScopeAccessInfo {
  userId: string
  venueId: string
  organizationId: string
  role: StaffRole
}

/**
 * Get venues based on the configured data scope
 *
 * @param accessInfo - User access information
 * @param dataScope - The scope to apply ('venue' | 'user-venues' | 'organization')
 * @returns Array of venues the user can access for this scope
 * @throws ForbiddenError if organization scope is requested by non-OWNER
 */
export async function getVenuesForScope(accessInfo: ScopeAccessInfo, dataScope: DataScope): Promise<ScopedVenue[]> {
  const { userId, venueId, organizationId, role } = accessInfo

  logger.debug(`scopedQuery.getVenuesForScope: scope=${dataScope}, userId=${userId}, venueId=${venueId}`)

  switch (dataScope) {
    case 'venue': {
      // Only the current venue
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: {
          id: true,
          slug: true,
          name: true,
          organizationId: true,
        },
      })

      if (!venue) {
        throw new ForbiddenError('Venue not found')
      }

      return [venue]
    }

    case 'user-venues': {
      // All venues the user has access to
      const staffVenues = await prisma.staffVenue.findMany({
        where: {
          staffId: userId,
          active: true,
        },
        select: {
          venue: {
            select: {
              id: true,
              slug: true,
              name: true,
              organizationId: true,
            },
          },
        },
      })

      return staffVenues.map(sv => sv.venue)
    }

    case 'organization': {
      // All venues in the organization - only OWNER can use this scope
      const allowedOrgScopeRoles: StaffRole[] = [StaffRole.SUPERADMIN, StaffRole.OWNER]

      if (!allowedOrgScopeRoles.includes(role)) {
        logger.warn(`scopedQuery.getVenuesForScope: User ${userId} with role ${role} attempted organization scope`)
        throw new ForbiddenError('Organization scope requires OWNER role')
      }

      const venues = await prisma.venue.findMany({
        where: {
          organizationId: organizationId,
        },
        select: {
          id: true,
          slug: true,
          name: true,
          organizationId: true,
        },
      })

      return venues
    }

    default: {
      // Fallback to single venue for unknown scopes (fail-closed)
      logger.warn(`scopedQuery.getVenuesForScope: Unknown dataScope '${dataScope}', defaulting to venue`)
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: {
          id: true,
          slug: true,
          name: true,
          organizationId: true,
        },
      })

      if (!venue) {
        throw new ForbiddenError('Venue not found')
      }

      return [venue]
    }
  }
}

/**
 * Get venue IDs based on the configured data scope
 * Convenience function that returns just the IDs
 *
 * @param accessInfo - User access information
 * @param dataScope - The scope to apply
 * @returns Array of venue IDs
 */
export async function getVenueIdsForScope(accessInfo: ScopeAccessInfo, dataScope: DataScope): Promise<string[]> {
  const venues = await getVenuesForScope(accessInfo, dataScope)
  return venues.map(v => v.id)
}

/**
 * Build a Prisma where clause for venue filtering
 * Useful for queries that need to filter by venueId
 *
 * @param accessInfo - User access information
 * @param dataScope - The scope to apply
 * @returns Prisma where clause object
 */
export async function buildVenueWhereClause(
  accessInfo: ScopeAccessInfo,
  dataScope: DataScope,
): Promise<{ venueId: string } | { venueId: { in: string[] } }> {
  if (dataScope === 'venue') {
    return { venueId: accessInfo.venueId }
  }

  const venueIds = await getVenueIdsForScope(accessInfo, dataScope)

  if (venueIds.length === 1) {
    return { venueId: venueIds[0] }
  }

  return { venueId: { in: venueIds } }
}

/**
 * Export for use in controllers
 */
export const scopedQueryService = {
  getVenuesForScope,
  getVenueIdsForScope,
  buildVenueWhereClause,
}
