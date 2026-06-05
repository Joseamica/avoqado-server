import { resolveActiveOrganizationId } from '../../../src/services/staffOrganization.service'

// resolveActiveOrganizationId + the helpers it calls (getPrimaryOrganizationId,
// getOrganizationIdFromVenue) all go through the prisma client — mock it so we test
// the real fallback logic end-to-end.
const mockStaffOrgFindFirst = jest.fn()
const mockStaffVenueFindFirst = jest.fn()
const mockVenueFindUnique = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffOrganization: { findFirst: (...a: unknown[]) => mockStaffOrgFindFirst(...(a as [])) },
    staffVenue: { findFirst: (...a: unknown[]) => mockStaffVenueFindFirst(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
  },
}))

describe('resolveActiveOrganizationId', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the org-level membership when present (no venue fallback)', async () => {
    mockStaffOrgFindFirst.mockResolvedValueOnce({ organizationId: 'org-primary' }) // isPrimary branch hits
    const org = await resolveActiveOrganizationId('s1')
    expect(org).toBe('org-primary')
    expect(mockStaffVenueFindFirst).not.toHaveBeenCalled()
  })

  it('falls back to the venue org for a venue-level owner with NO StaffOrganization (the Mindform case)', async () => {
    mockStaffOrgFindFirst.mockResolvedValue(null) // both primary + any-active queries → null → throws inside
    mockStaffVenueFindFirst.mockResolvedValueOnce({ venueId: 'v-mindform' })
    mockVenueFindUnique.mockResolvedValueOnce({ organizationId: 'org-mindform' })

    const org = await resolveActiveOrganizationId('s-mindform')

    expect(org).toBe('org-mindform')
    expect(mockStaffVenueFindFirst).toHaveBeenCalledTimes(1)
    expect(mockVenueFindUnique).toHaveBeenCalledTimes(1)
  })

  it('throws when the staff has neither an org membership nor any venue', async () => {
    mockStaffOrgFindFirst.mockResolvedValue(null)
    mockStaffVenueFindFirst.mockResolvedValueOnce(null)
    await expect(resolveActiveOrganizationId('s-orphan')).rejects.toThrow(/no organization membership or venue access/)
  })
})
