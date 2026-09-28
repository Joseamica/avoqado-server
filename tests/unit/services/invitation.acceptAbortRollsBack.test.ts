/**
 * 🔴 Codex (4th audit, 28-sep): when an accept aborts because the invitation stopped being PENDING, everything the accept
 * wrote must roll back with its transaction — including the org membership of someone coming from ANOTHER organization.
 * `createStaffOrganizationMembership` wrote with the global client, so that membership (even OWNER) survived the 409.
 * We assert the WIRING: the membership goes through the accept's own transaction client.
 */
import { InvitationStatus, OrgRole, StaffRole } from '@prisma/client'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const INVITATION = {
  id: 'inv-cross',
  token: 'cross-org-token',
  email: 'ana@other.com',
  role: StaffRole.MANAGER,
  status: InvitationStatus.PENDING,
  expiresAt: new Date(Date.now() + 86400000),
  organizationId: 'org-1',
  venueId: 'venue-1',
  invitedById: 'inviter-1',
  permissions: null,
  requirePin: false,
  organization: { id: 'org-1', name: 'Org' },
  venue: { id: 'venue-1', name: 'Venue' },
}

let mockLastTx: unknown = null
const mockInvitationUpdateMany = jest.fn()
const mockCreateMembership = jest.fn()

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        invitation: { findFirst: jest.fn().mockResolvedValue(INVITATION), updateMany: mockInvitationUpdateMany },
        staff: {
          // Someone who already has an account in ANOTHER organization, verifying with her password.
          findUnique: jest.fn().mockResolvedValue({
            id: 'staff-ana',
            email: 'ana@other.com',
            password: 'stored-hash',
            firstName: 'Ana',
            lastName: 'Ruiz',
            venues: [],
            organizations: [{ organizationId: 'org-other' }],
          }),
          update: jest.fn().mockResolvedValue({ id: 'staff-ana', email: 'ana@other.com', firstName: 'Ana', lastName: 'Ruiz' }),
        },
        staffOrganization: { update: jest.fn().mockResolvedValue({}) },
        staffVenue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({}),
        },
        venue: { findMany: jest.fn().mockResolvedValue([{ id: 'venue-1' }]) },
      }
      mockLastTx = tx
      return cb(tx)
    }),
  },
}))

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn().mockResolvedValue(true) }))
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
  createStaffOrganizationMembership: (...a: unknown[]) => mockCreateMembership(...a),
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
  getOrganizationIdFromVenue: jest.fn().mockResolvedValue('org-1'),
}))
jest.mock('../../../src/services/access/seatCap.service', () => ({
  assertCanAddSeatsBulk: jest.fn().mockResolvedValue(undefined),
}))

import { acceptInvitation } from '../../../src/services/invitation.service'

describe('acceptInvitation — an aborted accept leaves nothing behind', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInvitationUpdateMany.mockResolvedValue({ count: 1 })
    mockCreateMembership.mockResolvedValue(undefined)
  })

  it('🔴 the cross-org membership goes through the accept transaction, so the 409 rolls it back', async () => {
    mockInvitationUpdateMany.mockResolvedValueOnce({ count: 0 }) // revoked while she was accepting

    await expect(acceptInvitation('cross-org-token', { firstName: 'Ana', lastName: 'Ruiz', password: 'Password123' })).rejects.toThrow(
      'ya no está disponible',
    )

    expect(mockCreateMembership).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff-ana', organizationId: 'org-1', role: OrgRole.MEMBER }),
      mockLastTx,
    )
  })
})
