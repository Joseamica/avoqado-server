/**
 * Team Dashboard Service Tests
 *
 * Regression: the venue "Equipo" list (GET /dashboard/venues/:venueId/team →
 * getTeamMembers) queried StaffVenue by venueId only, so staff removed from the
 * org (StaffOrganization.isActive=false via removeFromOrganization / the
 * ex-collaborator cleanup) kept appearing. The fix filters on the venue's org
 * membership being active, while keeping venue-deactivated members (StaffVenue.active
 * =false, isActive stays true) visible so they can be reactivated.
 * See Asana 1215884464715725.
 */

import { getTeamMembers } from '@/services/dashboard/team.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const VENUE_ID = 'venue-1'
const ORG_ID = 'org-1'

const ACTIVE_ORG_MEMBER_FILTER = {
  staff: { organizations: { some: { organizationId: ORG_ID, isActive: true } } },
}

describe('getTeamMembers', () => {
  beforeEach(() => {
    // getTeamMembers uses the ARRAY form of $transaction; the global mock only
    // handles the callback form, so support arrays here.
    prismaMock.$transaction.mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock)))
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG_ID } as any)
    prismaMock.staffVenue.findMany.mockResolvedValue([])
    prismaMock.staffVenue.count.mockResolvedValue(0)
    prismaMock.order.groupBy.mockResolvedValue([] as any)
    prismaMock.payment.groupBy.mockResolvedValue([] as any)
  })

  it('hides org-removed members by filtering on the active org membership', async () => {
    await getTeamMembers(VENUE_ID, 1, 10)

    // The org-member filter is the fix: without it, staff with
    // StaffOrganization.isActive=false leak into the venue team list.
    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE_ID, ...ACTIVE_ORG_MEMBER_FILTER }),
      }),
    )
    // count must use the SAME where so pagination totals match the rows returned.
    expect(prismaMock.staffVenue.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE_ID, ...ACTIVE_ORG_MEMBER_FILTER }),
      }),
    )
  })

  it('still applies the org-member filter alongside a search term', async () => {
    await getTeamMembers(VENUE_ID, 1, 10, 'lopez')

    expect(prismaMock.staffVenue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE_ID,
          ...ACTIVE_ORG_MEMBER_FILTER,
          OR: expect.any(Array),
        }),
      }),
    )
  })
})
