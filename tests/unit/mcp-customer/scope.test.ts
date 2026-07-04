import { resolveScope } from '../../../src/mcp/scope'
import prisma from '@/utils/prismaClient'
import { getUserAccess } from '@/services/access/access.service'

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
const mockGetUserAccess = getUserAccess as jest.Mock

describe('resolveScope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.staffVenue.findFirst.mockResolvedValue(null) // default: NOT a platform superadmin
    mockGetUserAccess.mockImplementation(async (_s: string, venueId: string) => ({ venueId, corePermissions: ['venue:read'] }))
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

  it('SUPERADMIN detection filters revoked/deactivated (active:true + staff.active in the query)', async () => {
    // A revoked superadmin (StaffVenue.active=false, or Staff.active=false) must NOT keep the global
    // bypass. The DB returns no matching row → not superadmin → falls through to normal resolution.
    m.staffVenue.findFirst.mockResolvedValue(null) // no ACTIVE SUPERADMIN row for this staff
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'ADMIN', isActive: true })
    m.staffVenue.findMany.mockResolvedValue([{ venueId: 'A' }])

    const scope = await resolveScope('ex-super', 'org-1')

    expect(scope.isSuperAdmin).toBeFalsy() // no global access for a revoked superadmin
    // The guard lives in the query itself — assert the active filters are present.
    const where = m.staffVenue.findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ role: 'SUPERADMIN', active: true, staff: { active: true } })
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

  // Perf-fix regression guards: per-venue access is resolved CONCURRENTLY in bounded batches
  // (was a sequential await-loop → ~45s for an owner with 40 venues → MCP connect timeout).
  it('org OWNER with MANY venues -> ALL resolve across concurrency batches', async () => {
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'OWNER', isActive: true })
    m.venue.findMany.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ id: `V${i}` })))
    const scope = await resolveScope('owner', 'org-1')
    expect(scope.allowedVenueIds).toHaveLength(40)
    expect(scope.perVenueAccess.size).toBe(40)
    expect(mockGetUserAccess).toHaveBeenCalledTimes(40) // one per venue, just batched not serial
  })

  it('a per-venue access failure is isolated (skipped, not fatal to the whole scope)', async () => {
    m.staffOrganization.findUnique.mockResolvedValue({ role: 'OWNER', isActive: true })
    m.venue.findMany.mockResolvedValue([{ id: 'A' }, { id: 'B' }, { id: 'C' }])
    mockGetUserAccess.mockImplementation(async (_s: string, venueId: string) => {
      if (venueId === 'B') throw new Error('no access to this venue')
      return { venueId, corePermissions: ['venue:read'] }
    })
    const scope = await resolveScope('owner', 'org-1')
    expect(scope.allowedVenueIds.sort()).toEqual(['A', 'C']) // B skipped, A + C still resolved
  })
})
