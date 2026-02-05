/**
 * Access Service Tests
 *
 * Tests for the centralized permission system.
 * Uses the real database for integration testing.
 *
 * Run: npm test -- --testPathPattern=access.service.test
 */
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getUserAccess, hasPermission, canAccessFeature, createAccessCache, getFeatureDataScope } from '@/services/access/access.service'

describe('Access Service', () => {
  // Find test data before tests
  let superadminStaffId: string | null = null
  let superadminVenueId: string | null = null
  let regularStaffId: string | null = null
  let regularVenueId: string | null = null
  let whiteLabelVenueId: string | null = null
  let whiteLabelStaffId: string | null = null

  beforeAll(async () => {
    // Find a SUPERADMIN
    const superadminVenue = await prisma.staffVenue.findFirst({
      where: { role: StaffRole.SUPERADMIN },
      select: { staffId: true, venueId: true },
    })
    if (superadminVenue) {
      superadminStaffId = superadminVenue.staffId
      superadminVenueId = superadminVenue.venueId
    }

    // Find a regular venue (no white-label)
    const regularVenue = await prisma.venue.findFirst({
      where: {
        venueModules: {
          none: {
            module: { code: 'WHITE_LABEL_DASHBOARD' },
            enabled: true,
          },
        },
      },
      include: {
        staff: {
          where: { role: StaffRole.MANAGER },
          take: 1,
        },
      },
    })
    if (regularVenue && regularVenue.staff[0]) {
      regularVenueId = regularVenue.id
      regularStaffId = regularVenue.staff[0].staffId
    }

    // Find a white-label venue
    const wlVenue = await prisma.venue.findFirst({
      where: {
        venueModules: {
          some: {
            module: { code: 'WHITE_LABEL_DASHBOARD' },
            enabled: true,
          },
        },
      },
      include: {
        staff: {
          where: { role: { not: StaffRole.SUPERADMIN } },
          take: 1,
        },
      },
    })
    if (wlVenue && wlVenue.staff[0]) {
      whiteLabelVenueId = wlVenue.id
      whiteLabelStaffId = wlVenue.staff[0].staffId
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('getUserAccess', () => {
    it('should return SUPERADMIN role for superadmin users', async () => {
      if (!superadminStaffId || !superadminVenueId) {
        console.log('Skipping: No SUPERADMIN found')
        return
      }

      const access = await getUserAccess(superadminStaffId, superadminVenueId)
      expect(access.role).toBe(StaffRole.SUPERADMIN)
    })

    it('should allow SUPERADMIN to access any venue', async () => {
      if (!superadminStaffId) {
        console.log('Skipping: No SUPERADMIN found')
        return
      }

      // Find a different venue
      const otherVenue = await prisma.venue.findFirst({
        where: { id: { not: superadminVenueId! } },
      })

      if (otherVenue) {
        const access = await getUserAccess(superadminStaffId, otherVenue.id)
        expect(access.role).toBe(StaffRole.SUPERADMIN)
      }
    })

    it('should throw for users without venue access', async () => {
      if (!regularStaffId) {
        console.log('Skipping: No regular staff found')
        return
      }

      // Find a venue the user doesn't have access to
      const inaccessibleVenue = await prisma.venue.findFirst({
        where: {
          staff: {
            none: { staffId: regularStaffId },
          },
        },
      })

      if (inaccessibleVenue) {
        await expect(getUserAccess(regularStaffId, inaccessibleVenue.id)).rejects.toThrow('no access')
      }
    })

    it('should set whiteLabelEnabled=false for regular venues', async () => {
      if (!regularStaffId || !regularVenueId) {
        console.log('Skipping: No regular venue found')
        return
      }

      const access = await getUserAccess(regularStaffId, regularVenueId)
      expect(access.whiteLabelEnabled).toBe(false)
    })

    it('should set whiteLabelEnabled=true for white-label venues', async () => {
      if (!whiteLabelStaffId || !whiteLabelVenueId) {
        console.log('Skipping: No white-label venue found')
        return
      }

      const access = await getUserAccess(whiteLabelStaffId, whiteLabelVenueId)
      expect(access.whiteLabelEnabled).toBe(true)
    })

    it('should use request-level cache', async () => {
      if (!regularStaffId || !regularVenueId) {
        console.log('Skipping: No regular staff found')
        return
      }

      const cache = createAccessCache()

      const access1 = await getUserAccess(regularStaffId, regularVenueId, cache)
      const access2 = await getUserAccess(regularStaffId, regularVenueId, cache)

      // Should be the exact same object reference
      expect(access1).toBe(access2)
    })
  })

  describe('hasPermission', () => {
    it('should return true for SUPERADMIN for any permission', async () => {
      if (!superadminStaffId || !superadminVenueId) {
        console.log('Skipping: No SUPERADMIN found')
        return
      }

      const access = await getUserAccess(superadminStaffId, superadminVenueId)
      expect(hasPermission(access, 'tpv:create')).toBe(true)
      expect(hasPermission(access, 'nonexistent:permission')).toBe(true)
    })

    it('should check actual permissions for regular users', async () => {
      if (!regularStaffId || !regularVenueId) {
        console.log('Skipping: No regular staff found')
        return
      }

      const access = await getUserAccess(regularStaffId, regularVenueId)

      // MANAGER should have menu:read
      if (access.role === StaffRole.MANAGER) {
        expect(hasPermission(access, 'menu:read')).toBe(true)
      }
    })
  })

  describe('canAccessFeature', () => {
    it('should return allowed=true for SUPERADMIN', async () => {
      if (!superadminStaffId || !superadminVenueId) {
        console.log('Skipping: No SUPERADMIN found')
        return
      }

      const access = await getUserAccess(superadminStaffId, superadminVenueId)
      const result = canAccessFeature(access, 'ANY_FEATURE')
      expect(result.allowed).toBe(true)
    })

    it('should return allowed=true when white-label is disabled', async () => {
      if (!regularStaffId || !regularVenueId) {
        console.log('Skipping: No regular venue found')
        return
      }

      const access = await getUserAccess(regularStaffId, regularVenueId)
      const result = canAccessFeature(access, 'AVOQADO_TEAM')
      expect(result.allowed).toBe(true)
    })

    it('should check feature config when white-label is enabled', async () => {
      if (!whiteLabelStaffId || !whiteLabelVenueId) {
        console.log('Skipping: No white-label venue found')
        return
      }

      const access = await getUserAccess(whiteLabelStaffId, whiteLabelVenueId)

      // Disabled feature should not be allowed
      const disabledFeature = 'AVOQADO_MENU'
      if (!access.enabledFeatures.includes(disabledFeature)) {
        const result = canAccessFeature(access, disabledFeature)
        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('FEATURE_NOT_ENABLED')
      }
    })
  })

  describe('getFeatureDataScope', () => {
    it('should return venue scope when white-label is disabled', async () => {
      if (!regularStaffId || !regularVenueId) {
        console.log('Skipping: No regular venue found')
        return
      }

      const access = await getUserAccess(regularStaffId, regularVenueId)
      const scope = getFeatureDataScope(access, 'ANY_FEATURE')
      expect(scope).toBe('venue')
    })

    it('should return configured scope for white-label features', async () => {
      if (!whiteLabelStaffId || !whiteLabelVenueId) {
        console.log('Skipping: No white-label venue found')
        return
      }

      const access = await getUserAccess(whiteLabelStaffId, whiteLabelVenueId)

      if (access.enabledFeatures.length > 0) {
        const featureCode = access.enabledFeatures[0]
        const scope = getFeatureDataScope(access, featureCode)
        expect(['venue', 'user-venues', 'organization']).toContain(scope)
      }
    })
  })
})
