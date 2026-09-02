jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn(), findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn(), findMany: jest.fn() },
    staffOrganization: { findFirst: jest.fn() },
  },
}))

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { getConsolidatedRawMaterialInventory } from '@/services/dashboard/interVenueTransfer.service'

const prismaMock = prisma as unknown as {
  venue: { findUnique: jest.Mock; findMany: jest.Mock }
  staffVenue: { findFirst: jest.Mock; findMany: jest.Mock }
  staffOrganization: { findFirst: jest.Mock }
}

describe('getConsolidatedRawMaterialInventory access authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    prismaMock.staffVenue.findMany.mockResolvedValue([])
    prismaMock.venue.findMany.mockResolvedValue([])
  })

  it('requires an active Staff account for every SUPERADMIN, OWNER and venue-membership path', async () => {
    await expect(getConsolidatedRawMaterialInventory('venue-1', 'staff-1')).resolves.toEqual({ venues: [] })

    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith({
      where: {
        staffId: 'staff-1',
        active: true,
        role: 'SUPERADMIN',
        staff: { active: true },
      },
      select: { id: true },
    })
    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith({
      where: {
        staffId: 'staff-1',
        organizationId: 'org-1',
        isActive: true,
        role: 'OWNER',
        staff: { active: true },
      },
      select: { id: true },
    })
    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith({
      where: {
        staffId: 'staff-1',
        active: true,
        staff: { active: true },
        venue: { organizationId: 'org-1' },
      },
      select: { venueId: true },
    })
  })
})
