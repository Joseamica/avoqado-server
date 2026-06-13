import { resolveScope } from '../../../src/mcp/scope'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffOrganization: { findUnique: jest.fn() },
    venue: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  getUserAccess: jest.fn(async (_s: string, venueId: string) => ({ venueId, corePermissions: ['venue:read'] })),
  createAccessCache: jest.fn(() => ({})),
}))

const m = prisma as unknown as {
  staffOrganization: { findUnique: jest.Mock }
  venue: { findMany: jest.Mock }
  staffVenue: { findMany: jest.Mock; findFirst: jest.Mock }
}

describe('resolveScope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.staffVenue.findFirst.mockResolvedValue(null) // default: NOT a platform superadmin
  })

  it('platform SUPERADMIN -> ALL venues across ALL orgs, wildcard access, isSuperAdmin', async () => {
    m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-super' }) // has a SUPERADMIN StaffVenue
    m.venue.findMany.mockResolvedValue([
      { id: 'A', organizationId: 'org-1' },
      { id: 'B', organizationId: 'org-2' }, // another org — still in scope
    ])
    const scope = await resolveScope('super', 'org-1')

    expect(scope.isSuperAdmin).toBe(true)
    expect(scope.allowedVenueIds.sort()).toEqual(['A', 'B'])
    // synthesized wildcard access — hasPermission short-circuits on role SUPERADMIN
    expect(scope.perVenueAccess.get('B')).toMatchObject({ role: 'SUPERADMIN', corePermissions: ['*:*'], organizationId: 'org-2' })
    // and the org-membership path was never consulted
    expect(m.staffOrganization.findUnique).not.toHaveBeenCalled()
  })

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

  it('no org membership but has StaffVenue -> those venues (venue-level owner fallback, e.g. Mindform)', async () => {
    m.staffOrganization.findUnique.mockResolvedValue(null)
    m.staffVenue.findMany.mockResolvedValue([{ venueId: 'V-mindform' }])
    const scope = await resolveScope('venue-owner', 'org-1')
    expect(scope.allowedVenueIds).toEqual(['V-mindform'])
    expect(m.venue.findMany).not.toHaveBeenCalled() // not treated as an org-OWNER
  })

  it('no org membership and no StaffVenue -> empty', async () => {
    m.staffOrganization.findUnique.mockResolvedValue(null)
    m.staffVenue.findMany.mockResolvedValue([])
    expect((await resolveScope('orphan', 'org-1')).allowedVenueIds).toEqual([])
  })

  it('deactivated org membership -> empty (access revoked; no venue fallback)', async () => {
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'OWNER', isActive: false })
    const scope = await resolveScope('revoked', 'org-1')
    expect(scope.allowedVenueIds).toEqual([])
    expect(m.staffVenue.findMany).not.toHaveBeenCalled()
  })
})
