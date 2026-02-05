/**
 * Comprehensive Login Scenarios Tests
 *
 * Tests ALL possible login scenarios to ensure the pendingInvitations feature
 * doesn't break existing functionality.
 *
 * Scenarios covered:
 * 1. Normal login with venues
 * 2. Login with specific venueId
 * 3. OWNER without venues + onboarding incomplete (allowed)
 * 4. OWNER without venues + onboarding complete (falls through to invitation check)
 * 5. Non-OWNER without venues + pending invitations (NEW: redirects to invite)
 * 6. Non-OWNER without venues + no pending invitations (NO_VENUE_ACCESS)
 * 7. User with venues + pending invitations (normal login, ignores invitations)
 * 8. Locked account
 * 9. Wrong password
 * 10. Email not verified
 * 11. Inactive account
 * 12. White-label venue login
 * 13. Multi-org user login
 */

import { StaffRole, InvitationStatus, OrgRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

// Mock modules before imports
jest.mock('../../../src/utils/prismaClient')
jest.mock('../../../src/jwt.service')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  },
}))
jest.mock('../../../src/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
  hasOrganizationAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('../../../src/services/email.service', () => ({
  default: {
    sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
    sendEmailVerification: jest.fn().mockResolvedValue(true),
  },
}))

import prisma from '../../../src/utils/prismaClient'
import * as jwtService from '../../../src/jwt.service'
import { loginStaff } from '../../../src/services/dashboard/auth.service'

// Type the mocks
const mockPrisma = prisma as jest.Mocked<typeof prisma>
const mockJwtService = jwtService as jest.Mocked<typeof jwtService>

describe('Login Scenarios', () => {
  const validPassword = 'password123'
  let hashedPassword: string

  beforeAll(async () => {
    hashedPassword = await bcrypt.hash(validPassword, 10)
  })

  beforeEach(() => {
    jest.clearAllMocks()

    // Default JWT mock implementations
    mockJwtService.generateAccessToken = jest.fn().mockReturnValue('mock-access-token')
    mockJwtService.generateRefreshToken = jest.fn().mockReturnValue('mock-refresh-token')

    // Default prisma update mock
    ;(mockPrisma.staff.update as jest.Mock) = jest.fn().mockResolvedValue({})

    // Initialize invitation mock
    ;(mockPrisma as any).invitation = {
      findMany: jest.fn().mockResolvedValue([]),
    }
  })

  // Helper to create a staff object with venues
  const createStaffWithVenues = (overrides: any = {}) => ({
    id: 'staff-1',
    email: 'test@test.com',
    password: hashedPassword,
    firstName: 'Test',
    lastName: 'User',
    active: true,
    emailVerified: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    photoUrl: null,
    phone: null,
    createdAt: new Date(),
    lastLoginAt: null,
    venues: [
      {
        venueId: 'venue-1',
        role: StaffRole.ADMIN,
        venue: {
          id: 'venue-1',
          name: 'Test Venue',
          slug: 'test-venue',
          logo: null,
          status: 'ACTIVE',
          kycStatus: 'APPROVED',
          organizationId: 'org-1',
        },
      },
    ],
    organizations: [
      {
        organizationId: 'org-1',
        role: OrgRole.MEMBER,
        organization: {
          id: 'org-1',
          name: 'Test Org',
          email: 'owner@test.com',
          onboardingCompletedAt: new Date(),
        },
      },
    ],
    ...overrides,
  })

  // ============================================
  // SCENARIO 1: Normal login with venues
  // ============================================
  describe('Scenario 1: Normal login with venues', () => {
    it('should login successfully and return tokens', async () => {
      const staff = createStaffWithVenues()
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      const result = (await loginStaff({
        email: 'test@test.com',
        password: validPassword,
      })) as any

      expect(result.accessToken).toBe('mock-access-token')
      expect(result.refreshToken).toBe('mock-refresh-token')
      expect(result.staff.id).toBe('staff-1')
      expect(result.staff.venues).toHaveLength(1)
      expect(result.pendingInvitations).toBeUndefined()
    })

    it('should select first venue by default', async () => {
      const staff = createStaffWithVenues({
        venues: [
          {
            venueId: 'venue-1',
            role: StaffRole.ADMIN,
            venue: {
              id: 'venue-1',
              name: 'Venue 1',
              slug: 'venue-1',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
          {
            venueId: 'venue-2',
            role: StaffRole.MANAGER,
            venue: {
              id: 'venue-2',
              name: 'Venue 2',
              slug: 'venue-2',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      await loginStaff({ email: 'test@test.com', password: validPassword })

      // Should use first venue's data for token
      expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith('staff-1', 'org-1', 'venue-1', StaffRole.ADMIN, undefined)
    })
  })

  // ============================================
  // SCENARIO 2: Login with specific venueId
  // ============================================
  describe('Scenario 2: Login with specific venueId', () => {
    it('should login to specified venue', async () => {
      const staff = createStaffWithVenues({
        venues: [
          {
            venueId: 'venue-1',
            role: StaffRole.ADMIN,
            venue: {
              id: 'venue-1',
              name: 'Venue 1',
              slug: 'venue-1',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
          {
            venueId: 'venue-2',
            role: StaffRole.CASHIER,
            venue: {
              id: 'venue-2',
              name: 'Venue 2',
              slug: 'venue-2',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      await loginStaff({
        email: 'test@test.com',
        password: validPassword,
        venueId: 'venue-2',
      })

      expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith('staff-1', 'org-1', 'venue-2', StaffRole.CASHIER, undefined)
    })

    it('should reject login to venue user does not have access to', async () => {
      const staff = createStaffWithVenues()
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(
        loginStaff({
          email: 'test@test.com',
          password: validPassword,
          venueId: 'venue-not-assigned',
        }),
      ).rejects.toThrow('No tienes acceso a este establecimiento')
    })
  })

  // ============================================
  // SCENARIO 3: OWNER without venues + onboarding incomplete
  // ============================================
  describe('Scenario 3: OWNER without venues + onboarding incomplete', () => {
    it('should allow login for OWNER with incomplete onboarding', async () => {
      const staff = createStaffWithVenues({
        email: 'owner@test.com', // Same as org email (primary owner)
        venues: [], // No venues yet
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.OWNER,
            organization: {
              id: 'org-1',
              name: 'Test Org',
              email: 'owner@test.com',
              onboardingCompletedAt: null, // Onboarding NOT completed
            },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      const result = (await loginStaff({ email: 'owner@test.com', password: validPassword })) as any

      expect(result.accessToken).toBe('mock-access-token')
      expect(result.staff.venues).toHaveLength(0)
      expect(result.staff.role).toBe(StaffRole.OWNER)
      expect(result.pendingInvitations).toBeUndefined()

      // Should use 'pending' as venueId for onboarding
      expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'pending', StaffRole.OWNER)
    })
  })

  // ============================================
  // SCENARIO 4: OWNER without venues + onboarding complete (checks invitations)
  // ============================================
  describe('Scenario 4: OWNER without venues + onboarding complete', () => {
    it('should check for pending invitations when OWNER has no venues but onboarding is complete', async () => {
      const staff = createStaffWithVenues({
        email: 'owner@test.com',
        venues: [], // No venues
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.OWNER,
            organization: {
              id: 'org-1',
              name: 'Test Org',
              email: 'different-owner@test.com', // Different from staff email - not primary owner
              onboardingCompletedAt: new Date(), // Onboarding completed
            },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      // Should fail because no venues and no pending invitations
      await expect(loginStaff({ email: 'owner@test.com', password: validPassword })).rejects.toThrow(
        'No tienes acceso a ningún establecimiento',
      )
    })
  })

  // ============================================
  // SCENARIO 5: Non-OWNER without venues + pending invitations (NEW FEATURE)
  // ============================================
  describe('Scenario 5: Non-OWNER without venues + pending invitations', () => {
    it('should allow login and return pendingInvitations array', async () => {
      const staff = createStaffWithVenues({
        venues: [], // No active venues
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.MEMBER,
            organization: {
              id: 'org-1',
              name: 'Test Org',
              email: 'owner@test.com',
              onboardingCompletedAt: new Date(),
            },
          },
        ],
      })

      const pendingInvitations = [
        {
          id: 'inv-1',
          token: 'token-abc123',
          role: StaffRole.WAITER,
          venue: { id: 'venue-new', name: 'New Venue' },
          organization: { id: 'org-2', name: 'New Org' },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
        },
      ]

      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue(pendingInvitations)

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.accessToken).toBe('mock-access-token')
      expect(result.pendingInvitations).toBeDefined()
      expect(result.pendingInvitations).toHaveLength(1)
      expect(result.pendingInvitations[0].token).toBe('token-abc123')
      expect(result.pendingInvitations[0].organizationName).toBe('New Org')
      expect(result.pendingInvitations[0].venueName).toBe('New Venue')

      // Should use 'pending-invitation' as venueId and VIEWER role
      expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith('staff-1', 'org-1', 'pending-invitation', StaffRole.VIEWER)
    })

    it('should handle multiple pending invitations', async () => {
      const staff = createStaffWithVenues({
        venues: [],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.MEMBER,
            organization: { id: 'org-1', name: 'Org', email: 'x', onboardingCompletedAt: new Date() },
          },
        ],
      })

      const pendingInvitations = [
        {
          id: 'inv-1',
          token: 'token-1',
          role: StaffRole.WAITER,
          venue: { id: 'v1', name: 'Venue 1' },
          organization: { id: 'o1', name: 'Org 1' },
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          id: 'inv-2',
          token: 'token-2',
          role: StaffRole.CASHIER,
          venue: { id: 'v2', name: 'Venue 2' },
          organization: { id: 'o2', name: 'Org 2' },
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          id: 'inv-3',
          token: 'token-3',
          role: StaffRole.ADMIN,
          venue: null,
          organization: { id: 'o3', name: 'Org 3' },
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]

      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue(pendingInvitations)

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.pendingInvitations).toHaveLength(3)
      expect(result.pendingInvitations[2].venueName).toBeNull() // Org-level invitation
    })

    it('should handle invitation without venue (org-level invitation)', async () => {
      const staff = createStaffWithVenues({
        venues: [],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.MEMBER,
            organization: { id: 'org-1', name: 'Org', email: 'x', onboardingCompletedAt: new Date() },
          },
        ],
      })

      const pendingInvitations = [
        {
          id: 'inv-1',
          token: 'token-org',
          role: StaffRole.ADMIN,
          venue: null, // No specific venue
          organization: { id: 'org-new', name: 'New Organization' },
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]

      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue(pendingInvitations)

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.pendingInvitations[0].venueId).toBeNull()
      expect(result.pendingInvitations[0].venueName).toBeNull()
      expect(result.pendingInvitations[0].organizationName).toBe('New Organization')
    })
  })

  // ============================================
  // SCENARIO 6: Non-OWNER without venues + no pending invitations
  // ============================================
  describe('Scenario 6: Non-OWNER without venues + no pending invitations', () => {
    it('should throw NO_VENUE_ACCESS error', async () => {
      const staff = createStaffWithVenues({
        venues: [],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.MEMBER,
            organization: {
              id: 'org-1',
              name: 'Test Org',
              email: 'owner@test.com',
              onboardingCompletedAt: new Date(),
            },
          },
        ],
      })

      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue([]) // No invitations

      await expect(loginStaff({ email: 'test@test.com', password: validPassword })).rejects.toThrow(
        'No tienes acceso a ningún establecimiento',
      )
    })
  })

  // ============================================
  // SCENARIO 7: User with venues + pending invitations (normal login)
  // ============================================
  describe('Scenario 7: User with venues + pending invitations (should do normal login)', () => {
    it('should login normally and NOT return pendingInvitations', async () => {
      const staff = createStaffWithVenues({
        venues: [
          {
            venueId: 'venue-1',
            role: StaffRole.ADMIN,
            venue: {
              id: 'venue-1',
              name: 'Existing Venue',
              slug: 'existing',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
        ],
      })

      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])
      // Note: invitation.findMany should NOT be called because user has venues

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.accessToken).toBe('mock-access-token')
      expect(result.staff.venues).toHaveLength(1)
      expect(result.pendingInvitations).toBeUndefined()

      // Should NOT query for invitations
      expect(mockPrisma.invitation?.findMany).not.toHaveBeenCalled()

      // Should use real venue ID
      expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith('staff-1', 'org-1', 'venue-1', StaffRole.ADMIN, undefined)
    })
  })

  // ============================================
  // SCENARIO 8: Locked account
  // ============================================
  describe('Scenario 8: Locked account', () => {
    it('should reject login for locked account', async () => {
      const staff = createStaffWithVenues({
        lockedUntil: new Date(Date.now() + 30 * 60 * 1000), // Locked for 30 more minutes
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(loginStaff({ email: 'test@test.com', password: validPassword })).rejects.toThrow(/Account temporarily locked/)
    })

    it('should allow login if lock has expired', async () => {
      const staff = createStaffWithVenues({
        lockedUntil: new Date(Date.now() - 1000), // Lock expired 1 second ago
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.accessToken).toBe('mock-access-token')
    })
  })

  // ============================================
  // SCENARIO 9: Wrong password
  // ============================================
  describe('Scenario 9: Wrong password', () => {
    it('should reject login with wrong password', async () => {
      const staff = createStaffWithVenues()
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(loginStaff({ email: 'test@test.com', password: 'wrong-password' })).rejects.toThrow(
        'Correo electrónico o contraseña incorrectos',
      )
    })

    it('should increment failed attempts on wrong password', async () => {
      const staff = createStaffWithVenues({ failedLoginAttempts: 2 })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(loginStaff({ email: 'test@test.com', password: 'wrong-password' })).rejects.toThrow()

      expect(mockPrisma.staff.update).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
        data: { failedLoginAttempts: 3 },
      })
    })

    it('should lock account after 5 failed attempts', async () => {
      const staff = createStaffWithVenues({ failedLoginAttempts: 4 })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(loginStaff({ email: 'test@test.com', password: 'wrong-password' })).rejects.toThrow(/Account locked/)

      expect(mockPrisma.staff.update).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
        data: expect.objectContaining({
          failedLoginAttempts: 5,
          lockedUntil: expect.any(Date),
        }),
      })
    })
  })

  // ============================================
  // SCENARIO 10: Email not verified
  // ============================================
  describe('Scenario 10: Email not verified', () => {
    it('should reject login for unverified email', async () => {
      const staff = createStaffWithVenues({ emailVerified: false })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(loginStaff({ email: 'test@test.com', password: validPassword })).rejects.toThrow(/verify your email/)
    })
  })

  // ============================================
  // SCENARIO 11: Inactive account
  // ============================================
  describe('Scenario 11: Inactive account', () => {
    it('should reject login for inactive account', async () => {
      const staff = createStaffWithVenues({ active: false })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)

      await expect(loginStaff({ email: 'test@test.com', password: validPassword })).rejects.toThrow('Tu cuenta está desactivada')
    })
  })

  // ============================================
  // SCENARIO 12: White-label venue login
  // ============================================
  describe('Scenario 12: White-label venue login', () => {
    it('should login normally to white-label venue', async () => {
      const staff = createStaffWithVenues({
        venues: [
          {
            venueId: 'venue-wl',
            role: StaffRole.ADMIN,
            venue: {
              id: 'venue-wl',
              name: 'White Label Venue',
              slug: 'wl-venue',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.accessToken).toBe('mock-access-token')
      expect(result.staff.venues[0].slug).toBe('wl-venue')
    })
  })

  // ============================================
  // SCENARIO 13: Multi-org user login
  // ============================================
  describe('Scenario 13: Multi-org user login', () => {
    it('should login with venues from multiple organizations', async () => {
      const staff = createStaffWithVenues({
        venues: [
          {
            venueId: 'venue-org1',
            role: StaffRole.ADMIN,
            venue: {
              id: 'venue-org1',
              name: 'Org1 Venue',
              slug: 'org1-venue',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
          {
            venueId: 'venue-org2',
            role: StaffRole.MANAGER,
            venue: {
              id: 'venue-org2',
              name: 'Org2 Venue',
              slug: 'org2-venue',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-2',
            },
          },
        ],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.ADMIN,
            organization: { id: 'org-1', name: 'Org 1', email: 'x', onboardingCompletedAt: new Date() },
          },
          {
            organizationId: 'org-2',
            role: OrgRole.MEMBER,
            organization: { id: 'org-2', name: 'Org 2', email: 'y', onboardingCompletedAt: new Date() },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      const result = (await loginStaff({ email: 'test@test.com', password: validPassword })) as any

      expect(result.accessToken).toBe('mock-access-token')
      expect(result.staff.venues).toHaveLength(2)
    })

    it('should login to specific venue in second organization', async () => {
      const staff = createStaffWithVenues({
        venues: [
          {
            venueId: 'venue-org1',
            role: StaffRole.ADMIN,
            venue: {
              id: 'venue-org1',
              name: 'Org1 Venue',
              slug: 'org1-venue',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-1',
            },
          },
          {
            venueId: 'venue-org2',
            role: StaffRole.MANAGER,
            venue: {
              id: 'venue-org2',
              name: 'Org2 Venue',
              slug: 'org2-venue',
              logo: null,
              status: 'ACTIVE',
              kycStatus: 'APPROVED',
              organizationId: 'org-2',
            },
          },
        ],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.ADMIN,
            organization: { id: 'org-1', name: 'Org 1', email: 'x', onboardingCompletedAt: new Date() },
          },
          {
            organizationId: 'org-2',
            role: OrgRole.MEMBER,
            organization: { id: 'org-2', name: 'Org 2', email: 'y', onboardingCompletedAt: new Date() },
          },
        ],
      })
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.venueRolePermission.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      await loginStaff({
        email: 'test@test.com',
        password: validPassword,
        venueId: 'venue-org2',
      })

      // Should use org-2's ID for the token
      expect(mockJwtService.generateAccessToken).toHaveBeenCalledWith('staff-1', 'org-2', 'venue-org2', StaffRole.MANAGER, undefined)
    })
  })

  // ============================================
  // SCENARIO 14: User not found
  // ============================================
  describe('Scenario 14: User not found', () => {
    it('should reject login for non-existent user', async () => {
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(null)

      await expect(loginStaff({ email: 'nonexistent@test.com', password: validPassword })).rejects.toThrow(
        'Correo electrónico o contraseña incorrectos',
      )
    })
  })

  // ============================================
  // SCENARIO 15: Expired invitations should be ignored
  // ============================================
  describe('Scenario 15: Expired invitations should be ignored', () => {
    it('should not return expired invitations', async () => {
      const staff = createStaffWithVenues({
        venues: [],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.MEMBER,
            organization: { id: 'org-1', name: 'Org', email: 'x', onboardingCompletedAt: new Date() },
          },
        ],
      })

      // Mock returns no invitations because the query filters by expiresAt > now
      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      await expect(loginStaff({ email: 'test@test.com', password: validPassword })).rejects.toThrow(
        'No tienes acceso a ningún establecimiento',
      )

      // Verify the query filtered by expiration
      expect(mockPrisma.invitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: { gt: expect.any(Date) },
          }),
        }),
      )
    })
  })

  // ============================================
  // SCENARIO 16: Only PENDING invitations count
  // ============================================
  describe('Scenario 16: Only PENDING invitations count', () => {
    it('should only query for PENDING status invitations', async () => {
      const staff = createStaffWithVenues({
        venues: [],
        organizations: [
          {
            organizationId: 'org-1',
            role: OrgRole.MEMBER,
            organization: { id: 'org-1', name: 'Org', email: 'x', onboardingCompletedAt: new Date() },
          },
        ],
      })

      ;(mockPrisma.staff.findUnique as jest.Mock) = jest.fn().mockResolvedValue(staff)
      ;(mockPrisma.invitation.findMany as jest.Mock) = jest.fn().mockResolvedValue([])

      await expect(loginStaff({ email: 'test@test.com', password: validPassword })).rejects.toThrow(
        'No tienes acceso a ningún establecimiento',
      )

      // Verify the query filtered by PENDING status
      expect(mockPrisma.invitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: InvitationStatus.PENDING,
          }),
        }),
      )
    })
  })
})
