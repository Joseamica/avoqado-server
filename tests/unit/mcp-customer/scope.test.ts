import { resolveScope } from '../../../src/mcp/scope'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffOrganization: { findUnique: jest.fn() },
    venue: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  getUserAccess: jest.fn(async (_s: string, venueId: string) => ({ venueId, corePermissions: ['venue:read'] })),
  createAccessCache: jest.fn(() => ({})),
}))

const m = prisma as unknown as {
  staffOrganization: { findUnique: jest.Mock }
  venue: { findMany: jest.Mock }
  staffVenue: { findMany: jest.Mock }
}

describe('resolveScope', () => {
  beforeEach(() => jest.clearAllMocks())

  it('org OWNER -> all venues in the org', async () => {
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'OWNER', isActive: true })
    m.venue.findMany.mockResolvedValue([{ id: 'A' }, { id: 'B' }])
    const scope = await resolveScope('owner', 'org-1')
    expect(scope.allowedVenueIds.sort()).toEqual(['A', 'B'])
    expect(m.staffVenue.findMany).not.toHaveBeenCalled()
  })

  it('non-OWNER -> only assigned StaffVenue venues', async () => {
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'ADMIN', isActive: true })
    m.staffVenue.findMany.mockResolvedValue([{ venueId: 'A' }])
    const scope = await resolveScope('admin', 'org-1')
    expect(scope.allowedVenueIds).toEqual(['A'])
    expect(m.venue.findMany).not.toHaveBeenCalled()
  })

  it('ADMIN with no StaffVenue -> zero venues', async () => {
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'ADMIN', isActive: true })
    m.staffVenue.findMany.mockResolvedValue([])
    expect((await resolveScope('admin', 'org-1')).allowedVenueIds).toEqual([])
  })

  it('no/inactive org membership -> empty scope', async () => {
    m.staffOrganization.findUnique.mockResolvedValue(null)
    expect((await resolveScope('x', 'org-1')).allowedVenueIds).toEqual([])
  })
})
