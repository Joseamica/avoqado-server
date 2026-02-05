/**
 * Scoped Query Service Tests
 *
 * Tests for the data scope filtering service.
 * Uses the real database for integration testing.
 *
 * Run: npm test -- --testPathPattern=scopedQuery.service.test
 */
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getVenuesForScope, getVenueIdsForScope, buildVenueWhereClause, ScopeAccessInfo } from '@/services/access/scopedQuery.service'

describe('Scoped Query Service', () => {
  let ownerAccessInfo: ScopeAccessInfo | null = null
  let managerAccessInfo: ScopeAccessInfo | null = null

  beforeAll(async () => {
    // Find an OWNER
    const ownerVenue = await prisma.staffVenue.findFirst({
      where: { role: StaffRole.OWNER },
      include: {
        venue: true,
      },
    })

    if (ownerVenue) {
      ownerAccessInfo = {
        userId: ownerVenue.staffId,
        venueId: ownerVenue.venueId,
        organizationId: ownerVenue.venue.organizationId,
        role: StaffRole.OWNER,
      }
    }

    // Find a MANAGER
    const managerVenue = await prisma.staffVenue.findFirst({
      where: { role: StaffRole.MANAGER },
      include: {
        venue: true,
      },
    })

    if (managerVenue) {
      managerAccessInfo = {
        userId: managerVenue.staffId,
        venueId: managerVenue.venueId,
        organizationId: managerVenue.venue.organizationId,
        role: StaffRole.MANAGER,
      }
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('getVenuesForScope', () => {
    it('should return only current venue for venue scope', async () => {
      if (!ownerAccessInfo) {
        console.log('Skipping: No OWNER found')
        return
      }

      const venues = await getVenuesForScope(ownerAccessInfo, 'venue')
      expect(venues).toHaveLength(1)
      expect(venues[0].id).toBe(ownerAccessInfo.venueId)
    })

    it('should return user-accessible venues for user-venues scope', async () => {
      if (!ownerAccessInfo) {
        console.log('Skipping: No OWNER found')
        return
      }

      const venues = await getVenuesForScope(ownerAccessInfo, 'user-venues')
      expect(venues.length).toBeGreaterThanOrEqual(1)

      // All venues should have valid IDs
      venues.forEach((v: { id: string; name: string }) => {
        expect(v.id).toBeDefined()
        expect(v.name).toBeDefined()
      })
    })

    it('should return all org venues for organization scope (OWNER)', async () => {
      if (!ownerAccessInfo) {
        console.log('Skipping: No OWNER found')
        return
      }

      const venues = await getVenuesForScope(ownerAccessInfo, 'organization')
      expect(venues.length).toBeGreaterThanOrEqual(1)

      // All venues should belong to the same organization
      venues.forEach((v: { organizationId: string }) => {
        expect(v.organizationId).toBe(ownerAccessInfo!.organizationId)
      })
    })

    it('should deny organization scope for MANAGER', async () => {
      if (!managerAccessInfo) {
        console.log('Skipping: No MANAGER found')
        return
      }

      await expect(getVenuesForScope(managerAccessInfo, 'organization')).rejects.toThrow('OWNER')
    })
  })

  describe('getVenueIdsForScope', () => {
    it('should return array of venue IDs', async () => {
      if (!ownerAccessInfo) {
        console.log('Skipping: No OWNER found')
        return
      }

      const ids = await getVenueIdsForScope(ownerAccessInfo, 'venue')
      expect(ids).toHaveLength(1)
      expect(ids[0]).toBe(ownerAccessInfo.venueId)
    })
  })

  describe('buildVenueWhereClause', () => {
    it('should return simple venueId for single venue', async () => {
      if (!ownerAccessInfo) {
        console.log('Skipping: No OWNER found')
        return
      }

      const where = await buildVenueWhereClause(ownerAccessInfo, 'venue')
      expect(where).toEqual({ venueId: ownerAccessInfo.venueId })
    })

    it('should return { in: [...] } for multiple venues', async () => {
      if (!ownerAccessInfo) {
        console.log('Skipping: No OWNER found')
        return
      }

      const where = await buildVenueWhereClause(ownerAccessInfo, 'organization')

      // Check if org has multiple venues
      const orgVenueCount = await prisma.venue.count({
        where: { organizationId: ownerAccessInfo.organizationId },
      })

      if (orgVenueCount > 1) {
        expect(where).toHaveProperty('venueId')
        expect((where as any).venueId).toHaveProperty('in')
        expect((where as any).venueId.in).toHaveLength(orgVenueCount)
      } else {
        // Single venue - should be simple string
        expect(where).toHaveProperty('venueId')
        expect(typeof (where as any).venueId).toBe('string')
      }
    })
  })
})
