/**
 * Tests for StaffOrganization creation in signup flow
 * Verifies that signupUser creates a StaffOrganization record with OWNER role
 */

import { OrgRole } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'

// Mock prisma
jest.mock('../../../src/utils/prismaClient', () => {
  const staffOrganizationCreate = jest.fn().mockResolvedValue({})
  return {
    __esModule: true,
    default: {
      staff: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => {
        const tx = {
          organization: {
            create: jest.fn().mockResolvedValue({
              id: 'org-1',
              name: 'Test Org',
            }),
          },
          staff: {
            create: jest.fn().mockResolvedValue({
              id: 'staff-1',
              email: 'test@test.com',
              firstName: 'Test',
              lastName: 'User',
              photoUrl: null,
            }),
          },
          staffOrganization: {
            create: staffOrganizationCreate,
          },
          onboardingProgress: {
            create: jest.fn().mockResolvedValue({}),
          },
        }
        return cb(tx)
      }),
      staffOrganization: {
        create: staffOrganizationCreate,
      },
    },
  }
})

// Mock bcrypt
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}))

// Mock jwt service
jest.mock('../../../src/jwt.service', () => ({
  __esModule: true,
  generateAccessToken: jest.fn().mockReturnValue('mock-access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('mock-refresh-token'),
}))

// Mock email service
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendEmailVerification: jest.fn().mockResolvedValue(true),
  },
}))

// Mock staffOrganization service (for verifyEmailCode)
jest.mock('../../../src/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
}))

import { signupUser } from '../../../src/services/onboarding/signup.service'

describe('Signup - StaffOrganization creation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.staff.findUnique as jest.Mock).mockResolvedValue(null) // No existing staff
  })

  it('should create StaffOrganization with OWNER role during signup', async () => {
    const result = await signupUser({
      email: 'test@test.com',
      password: 'password123',
      firstName: 'Test',
      lastName: 'User',
      organizationName: 'Test Org',
    })

    // Verify the transaction callback was called
    expect(prisma.$transaction).toHaveBeenCalled()

    // Verify StaffOrganization was created inside the transaction
    expect(prisma.staffOrganization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffId: 'staff-1',
        organizationId: 'org-1',
        role: OrgRole.OWNER,
        isPrimary: true,
        isActive: true,
      }),
    })

    // Verify result structure
    expect(result.staff.id).toBe('staff-1')
    expect(result.organization.id).toBe('org-1')
  })
})
