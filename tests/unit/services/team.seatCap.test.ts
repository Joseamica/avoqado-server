/**
 * Free-tier seat cap enforcement at the team "direct add" path (TPV-only invite, which
 * creates the StaffVenue immediately) in inviteTeamMember.
 *
 * A Free (non-exempt) venue already at 2 active seats must reject a new TPV-only member
 * with the SEAT_CAP_REACHED 403, and must NOT create the StaffVenue.
 */
import { StaffRole, InvitationStatus } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'

jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendTeamInvitation: jest.fn().mockResolvedValue(true) },
}))
jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue('Mesero'),
}))

import { inviteTeamMember } from '../../../src/services/dashboard/team.dashboard.service'
import { SEAT_CAP_REACHED_CODE } from '../../../src/services/access/seatCap.service'

const VENUE_ID = 'venue-free-1'
const INVITER_ID = 'inviter-1'

const freeVenue = {
  id: VENUE_ID,
  slug: 'free-venue',
  name: 'Free Venue',
  organizationId: 'org-1',
  seatCapExempt: false, // enforced
  organization: { id: 'org-1', name: 'Org' },
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue(freeVenue as any)
  prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'Boss', lastName: 'Owner' } as any)
  // No PIN conflicts, no existing assignment.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.invitation.findFirst.mockResolvedValue(null)
  prismaMock.invitation.create.mockResolvedValue({
    id: 'inv-1',
    email: 'tpv@free.local',
    role: StaffRole.WAITER,
    status: InvitationStatus.PENDING,
    expiresAt: new Date(),
    createdAt: new Date(),
  } as any)
  prismaMock.staff.create.mockResolvedValue({ id: 'staff-new', email: 'tpv@free.local' } as any)
  prismaMock.staffOrganization.upsert.mockResolvedValue({} as any)
  // No paid base plan → Free.
  prismaMock.venueFeature.findMany.mockResolvedValue([])
})

describe('inviteTeamMember — Free-tier seat cap (TPV-only direct add)', () => {
  it('throws SEAT_CAP_REACHED (403) and does NOT create the StaffVenue when the Free venue is full (2 active seats)', async () => {
    prismaMock.staffVenue.count.mockResolvedValue(2) // at cap

    await expect(
      inviteTeamMember(VENUE_ID, INVITER_ID, {
        firstName: 'New',
        lastName: 'Cajero',
        role: StaffRole.WAITER,
        type: 'tpv-only',
        pin: '4321',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: SEAT_CAP_REACHED_CODE })

    // Cap reached → no new seat created.
    expect(prismaMock.staffVenue.upsert).not.toHaveBeenCalled()
  })

  it('allows the add when the Free venue is under the cap (1 active seat)', async () => {
    prismaMock.staffVenue.count.mockResolvedValue(1) // under cap
    prismaMock.staffVenue.upsert.mockResolvedValue({ id: 'sv-new' } as any)
    prismaMock.invitation.update.mockResolvedValue({} as any)

    await inviteTeamMember(VENUE_ID, INVITER_ID, {
      firstName: 'New',
      lastName: 'Cajero',
      role: StaffRole.WAITER,
      type: 'tpv-only',
      pin: '4321',
    })

    expect(prismaMock.staffVenue.upsert).toHaveBeenCalledTimes(1)
  })

  it('does NOT enforce the cap for a grandfathered (exempt) venue even at many seats', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ ...freeVenue, seatCapExempt: true } as any)
    prismaMock.staffVenue.count.mockResolvedValue(99)
    prismaMock.staffVenue.upsert.mockResolvedValue({ id: 'sv-new' } as any)
    prismaMock.invitation.update.mockResolvedValue({} as any)

    await inviteTeamMember(VENUE_ID, INVITER_ID, {
      firstName: 'New',
      lastName: 'Cajero',
      role: StaffRole.WAITER,
      type: 'tpv-only',
      pin: '4321',
    })

    expect(prismaMock.staffVenue.upsert).toHaveBeenCalledTimes(1)
  })
})

describe('inviteTeamMember — Free-tier seat cap enforced at email invite SEND time (GAP 2)', () => {
  beforeEach(() => {
    // staff.findUnique is used twice: (1) inviter lookup by id → must return a record, and
    // (2) invitee lookup by email → null (brand-new invitee, skips the "already a member" branch).
    prismaMock.staff.findUnique.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id ? ({ firstName: 'Boss', lastName: 'Owner' } as any) : null),
    )
    prismaMock.staffVenue.findUnique.mockResolvedValue(null as any)
    prismaMock.invitation.findFirst.mockResolvedValue(null as any)
    prismaMock.staffOrganization.create.mockResolvedValue({} as any)
  })

  const emailRequest = {
    email: 'newhire@example.com',
    firstName: 'New',
    lastName: 'Hire',
    role: StaffRole.WAITER,
  }

  it('throws SEAT_CAP_REACHED (403) and creates NO Invitation row when the Free venue is full (2 active seats)', async () => {
    prismaMock.staffVenue.count.mockResolvedValue(2) // at cap

    await expect(inviteTeamMember(VENUE_ID, INVITER_ID, emailRequest)).rejects.toMatchObject({
      statusCode: 403,
      code: SEAT_CAP_REACHED_CODE,
    })

    // Blocked at SEND time → no Invitation row and no Staff created.
    expect(prismaMock.invitation.create).not.toHaveBeenCalled()
    expect(prismaMock.staff.create).not.toHaveBeenCalled()
  })

  it('allows the email invite (creates the Invitation row) when the Free venue is under the cap (1 active seat)', async () => {
    prismaMock.staffVenue.count.mockResolvedValue(1) // under cap
    prismaMock.staff.create.mockResolvedValue({ id: 'staff-new', email: emailRequest.email } as any)

    await inviteTeamMember(VENUE_ID, INVITER_ID, emailRequest)

    expect(prismaMock.invitation.create).toHaveBeenCalledTimes(1)
  })

  it('does NOT block the email invite for a grandfathered (exempt) venue even when over the cap', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ ...freeVenue, seatCapExempt: true } as any)
    prismaMock.staffVenue.count.mockResolvedValue(99)
    prismaMock.staff.create.mockResolvedValue({ id: 'staff-new', email: emailRequest.email } as any)

    await inviteTeamMember(VENUE_ID, INVITER_ID, emailRequest)

    expect(prismaMock.invitation.create).toHaveBeenCalledTimes(1)
  })
})
