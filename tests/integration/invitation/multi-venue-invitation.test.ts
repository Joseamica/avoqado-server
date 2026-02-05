/**
 * tests/integration/invitation/multi-venue-invitation.test.ts
 *
 * Comprehensive integration tests for multi-venue invitation scenarios.
 *
 * Test Scenarios:
 * 1. New user invited to a venue → Creates Staff + StaffVenue with role
 * 2. WAITER in Venue A invited as ADMIN to Venue B (same org) → Adds StaffVenue with ADMIN role
 * 3. User invited to different organization → BLOCKED (409 error)
 * 4. Role isolation: User has different roles per venue
 * 5. Token generation reflects correct venue/role
 * 6. Re-invitation to same venue → Updates existing assignment
 */

// Setup env vars before imports
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret-invitation'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret-invitation'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

// Mock session middleware
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})

// Mock Swagger
jest.mock('../../../src/config/swagger', () => ({
  __esModule: true,
  setupSwaggerUI: jest.fn(),
}))

// Mock email service
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendInvitationEmail: jest.fn().mockResolvedValue(true),
  },
}))

// Mock logger
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

// Mock Prisma client
const mockPrismaClient = {
  staff: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  staffVenue: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  invitation: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  venue: {
    findUnique: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
  venueRoleConfig: {
    findFirst: jest.fn(),
  },
  staffOrganization: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn(),
  },
  $transaction: jest.fn(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
}

// Configure $transaction to execute the callback with the mock client
mockPrismaClient.$transaction.mockImplementation(async (callback: any) => {
  return callback(mockPrismaClient)
})

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: mockPrismaClient,
}))

// Import after mocks
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcrypt'
import { InvitationStatus, StaffRole } from '@prisma/client'
import * as invitationService from '../../../src/services/invitation.service'

describe('Multi-Venue Invitation Flow', () => {
  // Test data
  const org1Id = uuidv4()
  const org2Id = uuidv4()
  const venueAId = uuidv4()
  const venueBId = uuidv4()
  const venueCId = uuidv4() // In org2
  const existingUserId = uuidv4()
  const newUserId = uuidv4()
  const inviterId = uuidv4()

  const testEmail = 'waiter@restaurant.com'
  const newUserEmail = 'newuser@restaurant.com'
  const testPassword = 'SecurePass123!'

  // Pre-hashed password for existing user tests
  // The service compares userData.password against existingStaff.password using bcrypt
  let hashedTestPassword: string

  beforeAll(async () => {
    // Generate a real bcrypt hash for tests with existing users
    hashedTestPassword = await bcrypt.hash(testPassword, 12)
  })

  beforeEach(() => {
    jest.clearAllMocks()

    // Reset $transaction to execute callback
    mockPrismaClient.$transaction.mockImplementation(async (callback: any) => {
      return callback(mockPrismaClient)
    })
  })

  describe('Scenario 1: New user invited to a venue', () => {
    it('should create Staff + StaffVenue with correct role for new user', async () => {
      const invitationToken = 'new-user-token-123'

      // Mock invitation
      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: newUserEmail,
        role: StaffRole.WAITER,
        organizationId: org1Id,
        venueId: venueAId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueAId, name: 'Venue A' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Test' },
      })

      // Mock: No existing staff
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      // Mock staff creation
      const createdStaff = {
        id: newUserId,
        email: newUserEmail.toLowerCase(),
        firstName: 'New',
        lastName: 'User',
        emailVerified: true,
        active: true,
      }
      mockPrismaClient.staff.create.mockResolvedValue(createdStaff)

      // Mock StaffOrganization creation for new staff
      mockPrismaClient.staffOrganization.create.mockResolvedValue({
        staffId: newUserId,
        organizationId: org1Id,
        role: 'MEMBER',
        isPrimary: true,
        isActive: true,
      })

      // Mock: No existing StaffVenue assignment
      mockPrismaClient.staffVenue.findUnique.mockResolvedValue(null)

      // Mock StaffVenue creation
      mockPrismaClient.staffVenue.create.mockResolvedValue({
        id: uuidv4(),
        staffId: newUserId,
        venueId: venueAId,
        role: StaffRole.WAITER,
        active: true,
      })

      // Mock invitation update
      mockPrismaClient.invitation.update.mockResolvedValue({})

      // Mock first venue assignment lookup
      mockPrismaClient.staffVenue.findFirst.mockResolvedValue(null)

      // Mock venue lookup for token generation (getOrganizationIdFromVenue)
      mockPrismaClient.venue.findUnique.mockResolvedValue({ organizationId: org1Id })

      const result = await invitationService.acceptInvitation(invitationToken, {
        firstName: 'New',
        lastName: 'User',
        password: testPassword,
      })

      // Verify staff was created
      expect(mockPrismaClient.staff.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: newUserEmail.toLowerCase(),
          firstName: 'New',
          lastName: 'User',
          emailVerified: true,
          active: true,
        }),
      })

      // Verify StaffVenue was created with WAITER role
      expect(mockPrismaClient.staffVenue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          staffId: newUserId,
          venueId: venueAId,
          role: StaffRole.WAITER,
          active: true,
        }),
      })

      // Verify StaffOrganization was created
      expect(mockPrismaClient.staffOrganization.create).toHaveBeenCalled()

      // Verify result
      expect(result.user.email).toBe(newUserEmail.toLowerCase())
      expect(result.user.organizationId).toBe(org1Id)
      expect(result.tokens.refreshToken).toBeDefined()
    })
  })

  describe('Scenario 2: Existing WAITER in Venue A invited as ADMIN to Venue B (same org)', () => {
    it('should add StaffVenue with ADMIN role without modifying existing role in Venue A', async () => {
      const invitationToken = 'existing-user-new-venue-token'

      // Mock invitation for Venue B with ADMIN role
      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.ADMIN, // Invited as ADMIN to Venue B
        organizationId: org1Id,
        venueId: venueBId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueBId, name: 'Venue B' },
        invitedBy: { id: inviterId, firstName: 'Owner', lastName: 'Test' },
      })

      // Mock: User already exists in org1 (as WAITER in Venue A)
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
        firstName: 'Existing',
        lastName: 'Waiter',
        password: hashedTestPassword, // Use real bcrypt hash for password verification
        emailVerified: true,
        active: true,
        venues: [
          {
            id: uuidv4(),
            staffId: existingUserId,
            venueId: venueAId,
            role: StaffRole.WAITER,
            active: true,
          },
        ],
        organizations: [{ organizationId: org1Id }], // SAME org!
      })

      // Mock staff update (should only update active/emailVerified, not password)
      mockPrismaClient.staff.update.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
        firstName: 'Existing',
        lastName: 'Waiter',
        emailVerified: true,
        active: true,
      })

      // Mock venue lookup for token generation
      mockPrismaClient.venue.findUnique.mockResolvedValue({ organizationId: org1Id })

      // Mock: No existing StaffVenue for Venue B
      mockPrismaClient.staffVenue.findUnique.mockResolvedValue(null)

      // Mock StaffVenue creation for Venue B
      mockPrismaClient.staffVenue.create.mockResolvedValue({
        id: uuidv4(),
        staffId: existingUserId,
        venueId: venueBId,
        role: StaffRole.ADMIN, // NEW role for Venue B
        active: true,
      })

      // Mock invitation update
      mockPrismaClient.invitation.update.mockResolvedValue({})

      const result = await invitationService.acceptInvitation(invitationToken, {
        firstName: 'Existing',
        lastName: 'Waiter',
        password: testPassword,
      })

      // Verify NO new staff was created (reused existing)
      expect(mockPrismaClient.staff.create).not.toHaveBeenCalled()

      // Verify existing staff was updated (active, emailVerified)
      expect(mockPrismaClient.staff.update).toHaveBeenCalledWith({
        where: { id: existingUserId },
        data: expect.objectContaining({
          active: true,
          emailVerified: true,
        }),
      })

      // Verify NEW StaffVenue created for Venue B with ADMIN role
      expect(mockPrismaClient.staffVenue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          staffId: existingUserId,
          venueId: venueBId,
          role: StaffRole.ADMIN,
          active: true,
        }),
      })

      // Verify result uses existing user ID
      expect(result.user.id).toBe(existingUserId)
      expect(result.user.organizationId).toBe(org1Id)
    })

    it('should NOT overwrite existing password for users who already have one', async () => {
      const invitationToken = 'existing-user-password-test'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.MANAGER,
        organizationId: org1Id,
        venueId: venueBId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueBId, name: 'Venue B' },
        invitedBy: { id: inviterId, firstName: 'Owner', lastName: 'Test' },
      })

      // User already has a password
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
        firstName: 'Existing',
        lastName: 'User',
        password: hashedTestPassword, // Use real bcrypt hash for password verification
        emailVerified: true,
        active: true,
        venues: [],
        organizations: [{ organizationId: org1Id }],
      })

      mockPrismaClient.staff.update.mockImplementation((args: any) => {
        // Return updated staff
        return Promise.resolve({
          id: existingUserId,
          email: testEmail.toLowerCase(),
          ...args.data,
        })
      })

      mockPrismaClient.staffVenue.findUnique.mockResolvedValue(null)
      mockPrismaClient.staffVenue.create.mockResolvedValue({
        id: uuidv4(),
        staffId: existingUserId,
        venueId: venueBId,
        role: StaffRole.MANAGER,
        active: true,
      })
      mockPrismaClient.invitation.update.mockResolvedValue({})

      // Mock venue lookup for token generation
      mockPrismaClient.venue.findUnique.mockResolvedValue({ organizationId: org1Id })

      await invitationService.acceptInvitation(invitationToken, {
        firstName: 'Existing',
        lastName: 'User',
        password: testPassword, // Correct password for identity verification
      })

      // Verify password was NOT included in update (because user already has one)
      // The service verifies the password but doesn't overwrite existing passwords
      expect(mockPrismaClient.staff.update).toHaveBeenCalledWith({
        where: { id: existingUserId },
        data: expect.not.objectContaining({
          password: expect.any(String),
        }),
      })
    })
  })

  describe('Scenario 3: User invited to DIFFERENT organization → Cross-org membership created', () => {
    it('should create StaffOrganization membership for cross-org invitation', async () => {
      const invitationToken = 'different-org-token'

      // Invitation is for org2
      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.WAITER,
        organizationId: org2Id,
        venueId: venueCId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org2Id, name: 'Different Org' },
        venue: { id: venueCId, name: 'Venue C' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Other' },
      })

      // User exists in org1 (DIFFERENT from invitation's org2)
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
        firstName: 'Existing',
        lastName: 'User',
        password: hashedTestPassword, // Use real bcrypt hash for password verification
        emailVerified: true,
        active: true,
        venues: [
          {
            venueId: venueAId,
            role: StaffRole.WAITER,
            active: true,
          },
        ],
        organizations: [{ organizationId: org1Id }], // Different from invitation
      })

      // Mock staff update
      mockPrismaClient.staff.update.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
        firstName: 'Existing',
        lastName: 'User',
        emailVerified: true,
        active: true,
      })

      // Mock cross-org StaffOrganization upsert
      mockPrismaClient.staffOrganization.upsert.mockResolvedValue({
        staffId: existingUserId,
        organizationId: org2Id,
        role: 'MEMBER',
        isPrimary: false,
        isActive: true,
      })

      // Mock: No existing StaffVenue for Venue C
      mockPrismaClient.staffVenue.findUnique.mockResolvedValue(null)

      // Mock StaffVenue creation for Venue C
      mockPrismaClient.staffVenue.create.mockResolvedValue({
        id: uuidv4(),
        staffId: existingUserId,
        venueId: venueCId,
        role: StaffRole.WAITER,
        active: true,
      })

      // Mock invitation update
      mockPrismaClient.invitation.update.mockResolvedValue({})

      // Mock venue lookup for token generation
      mockPrismaClient.venue.findUnique.mockResolvedValue({ organizationId: org2Id })

      const result = await invitationService.acceptInvitation(invitationToken, {
        firstName: 'Existing',
        lastName: 'User',
        password: testPassword,
      })

      // Verify NO new staff was created (reused existing)
      expect(mockPrismaClient.staff.create).not.toHaveBeenCalled()

      // Verify StaffVenue was created for the new venue
      expect(mockPrismaClient.staffVenue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          staffId: existingUserId,
          venueId: venueCId,
          role: StaffRole.WAITER,
        }),
      })

      // Verify result
      expect(result.user.id).toBe(existingUserId)
      expect(result.user.organizationId).toBe(org2Id)
    })
  })

  describe('Scenario 4: Re-invitation to same venue → Updates existing assignment', () => {
    it('should update existing StaffVenue role when re-invited to same venue', async () => {
      const invitationToken = 're-invite-token'
      const existingAssignmentId = uuidv4()

      // Invitation to promote from WAITER to MANAGER in Venue A
      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.MANAGER, // Promotion!
        organizationId: org1Id,
        venueId: venueAId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueAId, name: 'Venue A' },
        invitedBy: { id: inviterId, firstName: 'Owner', lastName: 'Test' },
      })

      // User exists
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
        firstName: 'Existing',
        lastName: 'User',
        password: hashedTestPassword, // Use real bcrypt hash for password verification
        emailVerified: true,
        active: true,
        venues: [
          {
            id: existingAssignmentId,
            staffId: existingUserId,
            venueId: venueAId,
            role: StaffRole.WAITER, // Current role
            active: true,
          },
        ],
        organizations: [{ organizationId: org1Id }],
      })

      mockPrismaClient.staff.update.mockResolvedValue({
        id: existingUserId,
        email: testEmail.toLowerCase(),
      })

      // Mock venue lookup for token generation
      mockPrismaClient.venue.findUnique.mockResolvedValue({ organizationId: org1Id })

      // StaffVenue EXISTS for this venue
      mockPrismaClient.staffVenue.findUnique.mockResolvedValue({
        id: existingAssignmentId,
        staffId: existingUserId,
        venueId: venueAId,
        role: StaffRole.WAITER,
        active: true,
      })

      // Mock StaffVenue update
      mockPrismaClient.staffVenue.update.mockResolvedValue({
        id: existingAssignmentId,
        staffId: existingUserId,
        venueId: venueAId,
        role: StaffRole.MANAGER, // Updated role
        active: true,
      })

      mockPrismaClient.invitation.update.mockResolvedValue({})

      const result = await invitationService.acceptInvitation(invitationToken, {
        firstName: 'Existing',
        lastName: 'User',
        password: testPassword,
      })

      // Verify StaffVenue was UPDATED (not created)
      expect(mockPrismaClient.staffVenue.create).not.toHaveBeenCalled()
      expect(mockPrismaClient.staffVenue.update).toHaveBeenCalledWith({
        where: { id: existingAssignmentId },
        data: expect.objectContaining({
          role: StaffRole.MANAGER, // New role
          active: true,
        }),
      })

      expect(result.user.id).toBe(existingUserId)
    })
  })

  describe('Scenario 5: Expired invitation → REJECTED', () => {
    it('should reject expired invitation', async () => {
      const invitationToken = 'expired-token'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.WAITER,
        organizationId: org1Id,
        venueId: venueAId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueAId, name: 'Venue A' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Test' },
      })

      await expect(
        invitationService.acceptInvitation(invitationToken, {
          firstName: 'User',
          lastName: 'Test',
          password: testPassword,
        }),
      ).rejects.toThrow('expirado')

      expect(mockPrismaClient.staff.create).not.toHaveBeenCalled()
      expect(mockPrismaClient.staffVenue.create).not.toHaveBeenCalled()
    })
  })

  describe('Scenario 6: Invalid/used invitation → NOT FOUND', () => {
    it('should reject when invitation token not found', async () => {
      mockPrismaClient.invitation.findFirst.mockResolvedValue(null)

      await expect(
        invitationService.acceptInvitation('nonexistent-token', {
          firstName: 'User',
          lastName: 'Test',
          password: testPassword,
        }),
      ).rejects.toThrow('no encontrada')
    })
  })

  describe('getInvitationByToken - Frontend info', () => {
    it('should return userAlreadyHasPassword=true for existing user with password', async () => {
      const invitationToken = 'check-token'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.ADMIN,
        organizationId: org1Id,
        venueId: venueBId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueBId, name: 'Venue B' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Test' },
      })

      // User exists with password
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        firstName: 'Existing',
        lastName: 'User',
        password: '$2b$12$hashedpassword',
      })

      // Mock venueRoleConfig lookup
      mockPrismaClient.venueRoleConfig.findFirst.mockResolvedValue(null)

      const result = await invitationService.getInvitationByToken(invitationToken)

      expect(result.userAlreadyHasPassword).toBe(true)
      expect(result.existsInDifferentOrg).toBe(false)
      expect(result.firstName).toBe('Existing')
      expect(result.lastName).toBe('User')
    })

    it('should return existsInDifferentOrg=false for user in different org (multi-org now supported)', async () => {
      const invitationToken = 'diff-org-check-token'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: testEmail,
        role: StaffRole.WAITER,
        organizationId: org2Id, // Invitation is for org2
        venueId: venueCId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org2Id, name: 'Different Org' },
        venue: { id: venueCId, name: 'Venue C' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Other' },
      })

      // User exists in org1 (different!) — but multi-org is now supported
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        firstName: 'Existing',
        lastName: 'User',
        password: '$2b$12$hashedpassword',
      })

      mockPrismaClient.venueRoleConfig.findFirst.mockResolvedValue(null)

      const result = await invitationService.getInvitationByToken(invitationToken)

      // Multi-org supported: existsInDifferentOrg is always false now
      expect(result.existsInDifferentOrg).toBe(false)
      expect(result.userAlreadyHasPassword).toBe(true) // Has password regardless of org
    })

    it('should return both false for new user (no existing account)', async () => {
      const invitationToken = 'new-user-check-token'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: newUserEmail,
        role: StaffRole.CASHIER,
        organizationId: org1Id,
        venueId: venueAId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueAId, name: 'Venue A' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Test' },
      })

      // No existing user
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)
      mockPrismaClient.venueRoleConfig.findFirst.mockResolvedValue(null)

      const result = await invitationService.getInvitationByToken(invitationToken)

      expect(result.userAlreadyHasPassword).toBe(false)
      expect(result.existsInDifferentOrg).toBe(false)
      expect(result.firstName).toBeNull()
      expect(result.lastName).toBeNull()
    })
  })

  describe('PIN validation per venue', () => {
    it('should allow same PIN in different venues', async () => {
      const invitationToken = 'pin-token'
      const testPin = '1234'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: newUserEmail,
        role: StaffRole.WAITER,
        organizationId: org1Id,
        venueId: venueBId, // Different venue
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueBId, name: 'Venue B' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Test' },
      })

      mockPrismaClient.staff.findUnique.mockResolvedValue(null)
      mockPrismaClient.staff.create.mockResolvedValue({
        id: newUserId,
        email: newUserEmail.toLowerCase(),
      })

      // Mock StaffOrganization creation
      mockPrismaClient.staffOrganization.create.mockResolvedValue({
        staffId: newUserId,
        organizationId: org1Id,
      })

      // PIN does NOT exist in Venue B (should pass)
      mockPrismaClient.staffVenue.findFirst.mockResolvedValue(null)
      mockPrismaClient.staffVenue.findUnique.mockResolvedValue(null)
      mockPrismaClient.staffVenue.create.mockResolvedValue({
        id: uuidv4(),
        staffId: newUserId,
        venueId: venueBId,
        role: StaffRole.WAITER,
        pin: testPin,
        active: true,
      })
      mockPrismaClient.invitation.update.mockResolvedValue({})

      // Mock venue lookup for token generation
      mockPrismaClient.venue.findUnique.mockResolvedValue({ organizationId: org1Id })

      const result = await invitationService.acceptInvitation(invitationToken, {
        firstName: 'New',
        lastName: 'User',
        password: testPassword,
        pin: testPin,
      })

      expect(result.user).toBeDefined()
      expect(mockPrismaClient.staffVenue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pin: testPin,
        }),
      })
    })

    it('should reject duplicate PIN within same venue', async () => {
      const invitationToken = 'duplicate-pin-token'
      const duplicatePin = '5678'

      mockPrismaClient.invitation.findFirst.mockResolvedValue({
        id: uuidv4(),
        token: invitationToken,
        email: newUserEmail,
        role: StaffRole.WAITER,
        organizationId: org1Id,
        venueId: venueAId,
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        organization: { id: org1Id, name: 'Restaurant Org' },
        venue: { id: venueAId, name: 'Venue A' },
        invitedBy: { id: inviterId, firstName: 'Manager', lastName: 'Test' },
      })

      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      // PIN already exists in Venue A
      mockPrismaClient.staffVenue.findFirst.mockResolvedValue({
        id: uuidv4(),
        staffId: existingUserId,
        venueId: venueAId,
        pin: duplicatePin,
        active: true,
      })

      await expect(
        invitationService.acceptInvitation(invitationToken, {
          firstName: 'New',
          lastName: 'User',
          password: testPassword,
          pin: duplicatePin,
        }),
      ).rejects.toThrow('PIN no disponible')
    })
  })
})
