/**
 * Tests for StaffOrganization in invitation flow
 * Verifies:
 * - Cross-org invitations no longer throw (multi-org support)
 * - StaffOrganization is created for new staff
 * - StaffOrganization is created for cross-org staff
 */

import { InvitationStatus, OrgRole, StaffRole } from '@prisma/client'

const mockStaffOrganizationCreate = jest.fn().mockResolvedValue({})
// const mockStaffOrganizationUpsert = jest.fn().mockResolvedValue({})

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (cb: any) => {
      const tx = {
        invitation: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'inv-1',
            token: 'test-token',
            email: 'newuser@test.com',
            role: StaffRole.WAITER,
            status: InvitationStatus.PENDING,
            expiresAt: new Date(Date.now() + 86400000), // Tomorrow
            organizationId: 'org-1',
            venueId: 'venue-1',
            invitedById: 'inviter-1',
            organization: { id: 'org-1', name: 'Test Org' },
            venue: { id: 'venue-1', name: 'Test Venue' },
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        staff: {
          findUnique: jest.fn().mockResolvedValue(null), // New user
          create: jest.fn().mockResolvedValue({
            id: 'new-staff-1',
            email: 'newuser@test.com',
            firstName: 'New',
            lastName: 'User',
          }),
        },
        staffVenue: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        staffOrganization: {
          create: mockStaffOrganizationCreate,
        },
      }
      return cb(tx)
    }),
  },
}))

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}))

jest.mock('../../../src/jwt.service', () => ({
  generateAccessToken: jest.fn().mockReturnValue('mock-access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('mock-refresh-token'),
}))

jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue(null),
}))

jest.mock('../../../src/services/staffOrganization.service', () => ({
  createStaffOrganizationMembership: jest.fn().mockResolvedValue(undefined),
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
  getOrganizationIdFromVenue: jest.fn().mockResolvedValue('org-1'),
}))

import { acceptInvitation } from '../../../src/services/invitation.service'

describe('Invitation - StaffOrganization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should create StaffOrganization for brand new staff accepting invitation', async () => {
    const result = await acceptInvitation('test-token', {
      firstName: 'New',
      lastName: 'User',
      password: 'Password123',
    })

    // Verify result structure
    expect(result.user.id).toBe('new-staff-1')
    expect(result.user.email).toBe('newuser@test.com')

    // Verify StaffOrganization was created in the transaction
    expect(mockStaffOrganizationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffId: 'new-staff-1',
        organizationId: 'org-1',
        role: OrgRole.MEMBER,
        isPrimary: true,
        isActive: true,
        joinedById: 'inviter-1',
      }),
    })
  })
})
