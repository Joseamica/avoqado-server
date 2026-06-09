/**
 * Accept-time seat-cap off-by-one guard.
 *
 * Cap usage = active seats + PENDING invitations. At ACCEPT time, the invite being accepted is
 * still PENDING (it's marked ACCEPTED later in the same transaction). If the defense-in-depth
 * accept-time `assertCanAddSeat` counted that pending row, a legitimate accept on a venue at
 * (cap - 1) active would be double-counted (1 pending + the active seat it becomes) and wrongly
 * 403'd. The accept flow must therefore call `assertCanAddSeat(venueId, { excludeInvitationId })`
 * with the id of the invite being accepted, so it's dropped from the pending count.
 *
 * We assert the WIRING here (assertCanAddSeat is called with the right exclusion) — the math of
 * the exclusion itself is covered by seatCap.service.test.ts.
 */
import { InvitationStatus, StaffRole } from '@prisma/client'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const INVITATION = {
  id: 'inv-accept-1',
  token: 'accept-token',
  email: 'newuser@test.com',
  role: StaffRole.WAITER,
  status: InvitationStatus.PENDING,
  expiresAt: new Date(Date.now() + 86400000), // tomorrow — not expired
  organizationId: 'org-1',
  venueId: 'venue-1',
  invitedById: 'inviter-1',
  permissions: null,
  organization: { id: 'org-1', name: 'Test Org' },
  venue: { id: 'venue-1', name: 'Test Venue' },
}

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (cb: any) => {
      const tx = {
        invitation: {
          findFirst: jest.fn().mockResolvedValue(INVITATION),
          update: jest.fn().mockResolvedValue({}),
        },
        staff: {
          findUnique: jest.fn().mockResolvedValue(null), // brand-new user → StaffVenue.create branch
          create: jest.fn().mockResolvedValue({
            id: 'new-staff-1',
            email: 'newuser@test.com',
            firstName: 'New',
            lastName: 'User',
          }),
        },
        staffVenue: {
          findUnique: jest.fn().mockResolvedValue(null), // no existing assignment → new seat (cap checked)
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        staffOrganization: {
          create: jest.fn().mockResolvedValue({}),
        },
        venue: {
          findMany: jest.fn().mockResolvedValue([{ id: 'venue-1' }]),
        },
      }
      return cb(tx)
    }),
  },
}))

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed-password') }))
jest.mock('../../../src/jwt.service', () => ({
  generateAccessToken: jest.fn().mockReturnValue('mock-access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('mock-refresh-token'),
}))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue(null),
}))
jest.mock('../../../src/services/staffOrganization.service', () => ({
  createStaffOrganizationMembership: jest.fn().mockResolvedValue(undefined),
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
  getOrganizationIdFromVenue: jest.fn().mockResolvedValue('org-1'),
}))

// Spy on assertCanAddSeat so we can assert HOW the accept flow calls it (no-op so the accept
// itself proceeds — proves a legit accept is not blocked).
const assertCanAddSeat = jest.fn().mockResolvedValue(undefined)
jest.mock('../../../src/services/access/seatCap.service', () => ({
  assertCanAddSeat,
}))

import { acceptInvitation } from '../../../src/services/invitation.service'

describe('acceptInvitation — accept-time seat-cap off-by-one guard', () => {
  beforeEach(() => jest.clearAllMocks())

  it('passes excludeInvitationId of the invite being accepted, so its own pending row never blocks the accept', async () => {
    const result = await acceptInvitation('accept-token', {
      firstName: 'New',
      lastName: 'User',
      password: 'Password123',
    })

    // The accept succeeded (a legit accept is NOT wrongly blocked).
    expect(result.user.id).toBe('new-staff-1')

    // The cap check ran for the target venue, EXCLUDING the very invite being accepted.
    expect(assertCanAddSeat).toHaveBeenCalledWith('venue-1', { excludeInvitationId: 'inv-accept-1' })
  })
})
