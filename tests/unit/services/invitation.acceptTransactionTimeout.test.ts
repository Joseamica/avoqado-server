/**
 * Regression: acceptInvitation must NOT run on Prisma's default 5s interactive-transaction
 * timeout.
 *
 * PROD incident 2026-06-30 (P2028): an OWNER invitation with `permissions.inviteToAllVenues`
 * for a 40-venue org (PlayTelecom) fans out StaffVenue creation across every org venue inside
 * a SINGLE interactive transaction. The per-venue work (existence lookup + out-of-transaction
 * seat-cap reads + create) plus bcrypt.hash crossed Prisma's 5000ms default, so Prisma aborted
 * the transaction and the next `tx.staffVenue.findUnique` threw:
 *   "Transaction API error: Transaction not found ... old closed transaction" (P2028)
 * — leaving the invitation stuck PENDING (the new OWNER could never get in).
 *
 * The fix gives the transaction an explicit, generous timeout (and maxWait so it can still
 * START under connection-pool pressure). This test locks that in: the accept flow MUST pass
 * `$transaction` an options object whose timeout comfortably exceeds the 5s default.
 */
import { InvitationStatus, StaffRole } from '@prisma/client'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const INVITATION = {
  id: 'inv-allvenues-1',
  token: 'all-venues-token',
  email: 'newowner@test.com',
  role: StaffRole.OWNER,
  status: InvitationStatus.PENDING,
  expiresAt: new Date(Date.now() + 86400000), // tomorrow — not expired
  organizationId: 'org-1',
  venueId: 'venue-1',
  invitedById: 'inviter-1',
  permissions: { inviteToAllVenues: true }, // OWNER fan-out across the whole org
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
          findUnique: jest.fn().mockResolvedValue(null), // brand-new user
          create: jest.fn().mockResolvedValue({
            id: 'new-owner-1',
            email: 'newowner@test.com',
            firstName: 'New',
            lastName: 'Owner',
          }),
        },
        staffVenue: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]), // batched existence lookup → no existing assignments
          create: jest.fn().mockResolvedValue({}),
        },
        staffOrganization: {
          create: jest.fn().mockResolvedValue({}),
        },
        venue: {
          // simulate a large org fan-out
          findMany: jest.fn().mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ id: `venue-${i + 1}` }))),
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
jest.mock('../../../src/services/access/seatCap.service', () => ({
  assertCanAddSeatsBulk: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '../../../src/utils/prismaClient'
import { acceptInvitation } from '../../../src/services/invitation.service'

describe('acceptInvitation — interactive transaction timeout (P2028 regression)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('runs the accept transaction with an explicit timeout well above Prisma 5s default', async () => {
    await acceptInvitation('all-venues-token', {
      firstName: 'New',
      lastName: 'Owner',
      password: 'Password123',
    })

    const txMock = prisma.$transaction as jest.Mock
    expect(txMock).toHaveBeenCalledTimes(1)

    // Second arg = options. Must exist and raise the timeout above the 5000ms default that
    // caused the prod P2028 on the 40-venue fan-out.
    const options = txMock.mock.calls[0][1]
    expect(options).toBeDefined()
    expect(options.timeout).toBeGreaterThanOrEqual(15000)
    // maxWait lets the txn still acquire a pooled connection under load before timing out.
    expect(options.maxWait).toBeGreaterThanOrEqual(5000)
  })
})
