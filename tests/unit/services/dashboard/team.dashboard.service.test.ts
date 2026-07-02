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

import { getTeamMembers, updateTeamMember, inviteTeamMember } from '@/services/dashboard/team.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { StaffRole } from '@prisma/client'

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

/**
 * SECURITY regression: role-assignment privilege escalation.
 * A MANAGER (who holds teams:update / teams:invite by default) must NOT be able to
 * promote themselves or anyone to a role at/above their own level, nor assign
 * SUPERADMIN. `callerRole` is the caller's role RESOLVED for the venue (threaded
 * from req.resolvedRole by the controller). When absent (internal callers) the
 * guard is skipped, so existing invite/update tests are unaffected.
 */
describe('updateTeamMember — privilege-escalation guard', () => {
  const existingManager = {
    id: 'sv-mgr',
    venueId: VENUE_ID,
    staffId: 'staff-mgr',
    role: StaffRole.MANAGER,
    active: true,
    staff: { id: 'staff-mgr', firstName: 'M', lastName: 'X' },
  }

  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(existingManager as any)
  })

  it('blocks a MANAGER from promoting themselves to OWNER (self-promotion vector)', async () => {
    await expect(updateTeamMember(VENUE_ID, 'sv-mgr', { role: StaffRole.OWNER, callerRole: StaffRole.MANAGER })).rejects.toThrow(
      /No puedes asignar el rol/i,
    )
  })

  it('blocks a MANAGER from promoting a member to ADMIN', async () => {
    await expect(updateTeamMember(VENUE_ID, 'sv-mgr', { role: StaffRole.ADMIN, callerRole: StaffRole.MANAGER })).rejects.toThrow(
      /No puedes asignar el rol/i,
    )
  })

  it('still blocks assigning SUPERADMIN outright', async () => {
    await expect(updateTeamMember(VENUE_ID, 'sv-mgr', { role: StaffRole.SUPERADMIN, callerRole: StaffRole.OWNER })).rejects.toThrow(
      /SUPERADMIN/i,
    )
  })
})

describe('inviteTeamMember — privilege-escalation guard', () => {
  it('blocks a MANAGER from inviting an OWNER', async () => {
    await expect(
      inviteTeamMember(VENUE_ID, 'inviter', {
        firstName: 'A',
        lastName: 'B',
        role: StaffRole.OWNER,
        callerRole: StaffRole.MANAGER,
      }),
    ).rejects.toThrow(/No puedes invitar con el rol/i)
  })

  it('blocks a MANAGER from inviting an ADMIN', async () => {
    await expect(
      inviteTeamMember(VENUE_ID, 'inviter', {
        firstName: 'A',
        lastName: 'B',
        role: StaffRole.ADMIN,
        callerRole: StaffRole.MANAGER,
      }),
    ).rejects.toThrow(/No puedes invitar con el rol/i)
  })

  it('still blocks inviting SUPERADMIN regardless of caller role', async () => {
    await expect(
      inviteTeamMember(VENUE_ID, 'inviter', {
        firstName: 'A',
        lastName: 'B',
        role: StaffRole.SUPERADMIN,
        callerRole: StaffRole.OWNER,
      }),
    ).rejects.toThrow(/SUPERADMIN/i)
  })
})
