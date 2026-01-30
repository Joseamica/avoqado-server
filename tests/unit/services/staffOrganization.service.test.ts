import { OrgRole } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'

// Mock dependencies
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffOrganization: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
  },
}))

// Import after mocking
import {
  getPrimaryOrganizationId,
  getOrganizationIdFromVenue,
  hasOrganizationAccess,
  createStaffOrganizationMembership,
} from '../../../src/services/staffOrganization.service'

describe('StaffOrganization Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getPrimaryOrganizationId', () => {
    it('should return orgId from primary StaffOrganization', async () => {
      ;(prisma.staffOrganization.findFirst as jest.Mock).mockResolvedValueOnce({ organizationId: 'org-primary' })

      const result = await getPrimaryOrganizationId('staff-1')

      expect(result).toBe('org-primary')
      expect(prisma.staffOrganization.findFirst).toHaveBeenCalledWith({
        where: { staffId: 'staff-1', isPrimary: true, isActive: true },
        select: { organizationId: true },
      })
    })

    it('should fallback to any active membership when no primary exists', async () => {
      ;(prisma.staffOrganization.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // no primary
        .mockResolvedValueOnce({ organizationId: 'org-any' }) // any active

      const result = await getPrimaryOrganizationId('staff-1')

      expect(result).toBe('org-any')
      expect(prisma.staffOrganization.findFirst).toHaveBeenCalledTimes(2)
    })

    it('should throw if no organization membership exists', async () => {
      ;(prisma.staffOrganization.findFirst as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

      await expect(getPrimaryOrganizationId('nonexistent')).rejects.toThrow('Staff has no organization membership: nonexistent')
    })
  })

  describe('getOrganizationIdFromVenue', () => {
    it('should return organizationId from venue', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({
        organizationId: 'org-from-venue',
      })

      const result = await getOrganizationIdFromVenue('venue-1')

      expect(result).toBe('org-from-venue')
      expect(prisma.venue.findUnique).toHaveBeenCalledWith({
        where: { id: 'venue-1' },
        select: { organizationId: true },
      })
    })

    it('should throw if venue not found', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue(null)

      await expect(getOrganizationIdFromVenue('nonexistent')).rejects.toThrow('Venue not found: nonexistent')
    })
  })

  describe('hasOrganizationAccess', () => {
    it('should return true when active membership exists', async () => {
      ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue({
        isActive: true,
      })

      const result = await hasOrganizationAccess('staff-1', 'org-1')

      expect(result).toBe(true)
    })

    it('should return false when membership is inactive', async () => {
      ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue({
        isActive: false,
      })

      const result = await hasOrganizationAccess('staff-1', 'org-1')

      expect(result).toBe(false)
    })

    it('should return false when no membership exists', async () => {
      ;(prisma.staffOrganization.findUnique as jest.Mock).mockResolvedValue(null)

      const result = await hasOrganizationAccess('staff-1', 'org-1')

      expect(result).toBe(false)
    })
  })

  describe('createStaffOrganizationMembership', () => {
    it('should upsert a StaffOrganization record', async () => {
      ;(prisma.staffOrganization.upsert as jest.Mock).mockResolvedValue({})

      await createStaffOrganizationMembership({
        staffId: 'staff-1',
        organizationId: 'org-1',
        role: OrgRole.OWNER,
        isPrimary: true,
        joinedById: 'inviter-1',
      })

      expect(prisma.staffOrganization.upsert).toHaveBeenCalledWith({
        where: {
          staffId_organizationId: {
            staffId: 'staff-1',
            organizationId: 'org-1',
          },
        },
        update: {
          isActive: true,
          role: OrgRole.OWNER,
          isPrimary: true,
          leftAt: null,
        },
        create: {
          staffId: 'staff-1',
          organizationId: 'org-1',
          role: OrgRole.OWNER,
          isPrimary: true,
          isActive: true,
          joinedById: 'inviter-1',
        },
      })
    })

    it('should handle missing joinedById', async () => {
      ;(prisma.staffOrganization.upsert as jest.Mock).mockResolvedValue({})

      await createStaffOrganizationMembership({
        staffId: 'staff-1',
        organizationId: 'org-1',
        role: OrgRole.MEMBER,
        isPrimary: false,
      })

      expect(prisma.staffOrganization.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            joinedById: undefined,
          }),
        }),
      )
    })
  })
})
