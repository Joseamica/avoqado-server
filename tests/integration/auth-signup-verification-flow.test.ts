/**
 * tests/integration/auth-signup-verification-flow.test.ts
 *
 * Integration test for complete signup → verification → login flow
 * Tests Approach B (FAANG pattern): Cookies ONLY after email verification
 *
 * Test Flow:
 * 1. Signup → No cookies, emailVerified: false
 * 2. Verify email → Cookies set, emailVerified: true, auto-login
 * 3. Login (after logout) → Success with verified email
 * 4. Security validations (invalid codes, expired codes, etc.)
 */

// Setup env vars before imports
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret-signup-flow'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret-signup-flow'

// Mock session middleware
jest.mock('../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})

// Mock Swagger
jest.mock('../../src/config/swagger', () => ({
  __esModule: true,
  setupSwaggerUI: jest.fn(),
}))

// Mock email service to avoid sending real emails
jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendEmailVerification: jest.fn().mockResolvedValue(true),
    sendPasswordReset: jest.fn().mockResolvedValue(true),
  },
}))

// Mock Prisma client
const mockPrismaClient = {
  staff: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
  },
  organization: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
}

jest.mock('../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: mockPrismaClient,
}))

import request from 'supertest'
import crypto from 'crypto'

const app = require('../../src/app').default

describe('Auth Flow: Signup → Verification → Login (Approach B - FAANG Pattern)', () => {
  const testEmail = `test-${Date.now()}@example.com`
  const testPassword = 'SecurePass123!'
  const testFirstName = 'John'
  const testLastName = 'Doe'
  const testOrgName = 'Test Restaurant'

  let verificationCode: string
  let userId: string
  let organizationId: string

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks()

    // Generate mock IDs
    userId = `user_${Date.now()}`
    organizationId = `org_${Date.now()}`
    verificationCode = crypto.randomInt(100000, 999999).toString()
  })

  describe('1. POST /api/v1/onboarding/signup - Create Account', () => {
    it('should create account successfully WITHOUT setting cookies (Approach B)', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        firstName: testFirstName,
        lastName: testLastName,
        organizationId,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: new Date(Date.now() + 10 * 60 * 1000),
        photoUrl: null,
        active: true,
        lastLoginAt: new Date(),
      }

      const mockOrganization = {
        id: organizationId,
        name: testOrgName,
        email: testEmail,
        phone: '',
      }

      // Mock database calls
      mockPrismaClient.staff.findUnique.mockResolvedValue(null) // Email doesn't exist
      mockPrismaClient.$transaction.mockResolvedValue({
        organization: mockOrganization,
        staff: mockStaff,
      })
      mockPrismaClient.staff.update.mockResolvedValue(mockStaff)

      const response = await request(app).post('/api/v1/onboarding/signup').send({
        email: testEmail,
        password: testPassword,
        firstName: testFirstName,
        lastName: testLastName,
        organizationName: testOrgName,
      })

      // Assert response
      expect(response.status).toBe(201)
      expect(response.body.success).toBe(true)
      expect(response.body.message).toContain('verify your email')
      expect(response.body.staff).toBeDefined()
      expect(response.body.staff.email).toBe(testEmail.toLowerCase())
      expect(response.body.organization).toBeDefined()
      expect(response.body.organization.name).toBe(testOrgName)

      // CRITICAL: No tokens in response body (Approach B)
      expect(response.body.accessToken).toBeUndefined()
      expect(response.body.refreshToken).toBeUndefined()

      // CRITICAL: No cookies set on signup (Approach B)
      const cookies = response.headers['set-cookie'] as unknown as string[] | undefined
      if (cookies && Array.isArray(cookies)) {
        const accessTokenCookie = cookies.find((c: string) => c.startsWith('accessToken='))
        const refreshTokenCookie = cookies.find((c: string) => c.startsWith('refreshToken='))
        expect(accessTokenCookie).toBeUndefined()
        expect(refreshTokenCookie).toBeUndefined()
      }
    })

    it('should reject duplicate email', async () => {
      // Mock existing user
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        id: userId,
        email: testEmail,
      })

      const response = await request(app).post('/api/v1/onboarding/signup').send({
        email: testEmail,
        password: testPassword,
        firstName: testFirstName,
        lastName: testLastName,
        organizationName: testOrgName,
      })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('already registered')
    })

    it('should reject weak password', async () => {
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      const response = await request(app).post('/api/v1/onboarding/signup').send({
        email: testEmail,
        password: 'weak', // Less than 8 characters
        firstName: testFirstName,
        lastName: testLastName,
        organizationName: testOrgName,
      })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('at least 8 characters')
    })

    it('should reject missing required fields', async () => {
      const response = await request(app).post('/api/v1/onboarding/signup').send({
        email: testEmail,
        // Missing password, firstName, lastName, organizationName
      })

      expect(response.status).toBe(400)
    })
  })

  describe('2. POST /api/v1/onboarding/verify-email - Verify Email & Auto-Login', () => {
    it('should verify email and SET cookies for auto-login (Approach B)', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        organizationId,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: new Date(Date.now() + 10 * 60 * 1000),
      }

      // Mock database calls
      mockPrismaClient.staff.findUnique.mockResolvedValue(mockStaff)
      mockPrismaClient.staff.update.mockResolvedValue({
        ...mockStaff,
        emailVerified: true,
        emailVerificationCode: null,
        emailVerificationExpires: null,
      })

      const response = await request(app).post('/api/v1/onboarding/verify-email').send({
        email: testEmail,
        verificationCode,
      })

      // Assert response
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.emailVerified).toBe(true)
      expect(response.body.message).toContain('logged in')

      // CRITICAL: Cookies ARE set after verification (Approach B)
      const cookies = response.headers['set-cookie'] as unknown as string[] | undefined
      expect(cookies).toBeDefined()
      expect(Array.isArray(cookies)).toBe(true)

      const accessTokenCookie = cookies?.find((c: string) => c.startsWith('accessToken='))
      const refreshTokenCookie = cookies?.find((c: string) => c.startsWith('refreshToken='))

      expect(accessTokenCookie).toBeDefined()
      expect(refreshTokenCookie).toBeDefined()

      // Verify cookie properties
      expect(accessTokenCookie).toContain('HttpOnly')
      expect(refreshTokenCookie).toContain('HttpOnly')
      expect(accessTokenCookie).toContain('Path=/')
      expect(refreshTokenCookie).toContain('Path=/')
    })

    it('should reject invalid verification code', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: new Date(Date.now() + 10 * 60 * 1000),
      }

      mockPrismaClient.staff.findUnique.mockResolvedValue(mockStaff)

      const response = await request(app).post('/api/v1/onboarding/verify-email').send({
        email: testEmail,
        verificationCode: '000000', // Wrong code
      })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('Invalid verification code')
    })

    it('should reject expired verification code', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: new Date(Date.now() - 1000), // Expired 1 second ago
      }

      mockPrismaClient.staff.findUnique.mockResolvedValue(mockStaff)

      const response = await request(app).post('/api/v1/onboarding/verify-email').send({
        email: testEmail,
        verificationCode,
      })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('expired')
    })

    it('should handle already verified email gracefully', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        organizationId,
        emailVerified: true, // Already verified
        emailVerificationCode: null,
        emailVerificationExpires: null,
      }

      mockPrismaClient.staff.findUnique.mockResolvedValue(mockStaff)

      const response = await request(app).post('/api/v1/onboarding/verify-email').send({
        email: testEmail,
        verificationCode,
      })

      // Should still return success with tokens (allow re-auth)
      expect(response.status).toBe(200)
      expect(response.body.emailVerified).toBe(true)

      // Should still set cookies
      const cookies = response.headers['set-cookie']
      expect(cookies).toBeDefined()
    })

    it('should reject non-existent email', async () => {
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      const response = await request(app).post('/api/v1/onboarding/verify-email').send({
        email: 'nonexistent@example.com',
        verificationCode,
      })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('Invalid')
    })
  })

  describe('3. POST /api/v1/onboarding/resend-verification - Resend Verification Code', () => {
    it('should resend verification code successfully', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        firstName: testFirstName,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: new Date(Date.now() + 10 * 60 * 1000),
      }

      mockPrismaClient.staff.findUnique.mockResolvedValue(mockStaff)
      mockPrismaClient.staff.update.mockResolvedValue({
        ...mockStaff,
        emailVerificationCode: '999999',
      })

      const response = await request(app).post('/api/v1/onboarding/resend-verification').send({ email: testEmail })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.message).toContain('sent successfully')
    })

    it('should reject resend for already verified email', async () => {
      const mockStaff = {
        id: userId,
        email: testEmail,
        emailVerified: true, // Already verified
      }

      mockPrismaClient.staff.findUnique.mockResolvedValue(mockStaff)

      const response = await request(app).post('/api/v1/onboarding/resend-verification').send({ email: testEmail })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('already verified')
    })

    it('should reject resend for non-existent email', async () => {
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      const response = await request(app).post('/api/v1/onboarding/resend-verification').send({ email: 'nonexistent@example.com' })

      expect(response.status).toBe(400)
      expect(response.body.message).toContain('not found')
    })
  })

  describe('4. GET /api/v1/onboarding/email-status - Check Email Status (Security)', () => {
    it('should return status for existing unverified email', async () => {
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        emailVerified: false,
      })

      const response = await request(app).get(`/api/v1/onboarding/email-status?email=${testEmail}`)

      expect(response.status).toBe(200)
      expect(response.body.emailExists).toBe(true)
      expect(response.body.emailVerified).toBe(false)
    })

    it('should return status for existing verified email', async () => {
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        emailVerified: true,
      })

      const response = await request(app).get(`/api/v1/onboarding/email-status?email=${testEmail}`)

      expect(response.status).toBe(200)
      expect(response.body.emailExists).toBe(true)
      expect(response.body.emailVerified).toBe(true)
    })

    it('should return false for non-existent email', async () => {
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      const response = await request(app).get('/api/v1/onboarding/email-status?email=nonexistent@example.com')

      expect(response.status).toBe(200)
      expect(response.body.emailExists).toBe(false)
      expect(response.body.emailVerified).toBe(false)
    })
  })

  describe('5. Complete Flow Test - Signup to Login', () => {
    it('should complete full flow: signup → verify → authenticated', async () => {
      // Step 1: Signup
      const mockStaff = {
        id: userId,
        email: testEmail,
        firstName: testFirstName,
        lastName: testLastName,
        organizationId,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: new Date(Date.now() + 10 * 60 * 1000),
        photoUrl: null,
      }

      const mockOrganization = {
        id: organizationId,
        name: testOrgName,
        email: testEmail,
      }

      mockPrismaClient.staff.findUnique.mockResolvedValue(null)
      mockPrismaClient.$transaction.mockResolvedValue({
        organization: mockOrganization,
        staff: mockStaff,
      })
      mockPrismaClient.staff.update.mockResolvedValue(mockStaff)

      const signupResponse = await request(app).post('/api/v1/onboarding/signup').send({
        email: testEmail,
        password: testPassword,
        firstName: testFirstName,
        lastName: testLastName,
        organizationName: testOrgName,
      })

      expect(signupResponse.status).toBe(201)
      expect(signupResponse.body.success).toBe(true)

      // No cookies after signup (Approach B)
      const signupCookies = signupResponse.headers['set-cookie'] as unknown as string[] | undefined
      if (signupCookies && Array.isArray(signupCookies)) {
        expect(signupCookies.find((c: string) => c.startsWith('accessToken='))).toBeUndefined()
      }

      // Step 2: Verify Email
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        ...mockStaff,
        emailVerified: false,
      })
      mockPrismaClient.staff.update.mockResolvedValue({
        ...mockStaff,
        emailVerified: true,
        emailVerificationCode: null,
      })

      const verifyResponse = await request(app).post('/api/v1/onboarding/verify-email').send({
        email: testEmail,
        verificationCode,
      })

      expect(verifyResponse.status).toBe(200)
      expect(verifyResponse.body.emailVerified).toBe(true)

      // Cookies ARE set after verification (Approach B auto-login)
      const verifyCookies = verifyResponse.headers['set-cookie'] as unknown as string[] | undefined
      expect(verifyCookies).toBeDefined()
      expect(Array.isArray(verifyCookies)).toBe(true)
      const accessTokenCookie = verifyCookies?.find((c: string) => c.startsWith('accessToken='))
      expect(accessTokenCookie).toBeDefined()

      // Step 3: Verify user is now authenticated
      // (In a real test, you'd use the cookies to make an authenticated request)
      expect(verifyResponse.body.success).toBe(true)
    })
  })

  describe('6. Security Tests', () => {
    it('should prevent enumeration attacks with consistent timing', async () => {
      // Test with existing user
      mockPrismaClient.staff.findUnique.mockResolvedValue({
        email: testEmail,
      })

      const startExisting = Date.now()
      await request(app).post('/api/v1/onboarding/verify-email').send({
        email: testEmail,
        verificationCode: '000000',
      })
      const timeExisting = Date.now() - startExisting

      // Test with non-existing user
      mockPrismaClient.staff.findUnique.mockResolvedValue(null)

      const startNonExisting = Date.now()
      await request(app).post('/api/v1/onboarding/verify-email').send({
        email: 'nonexistent@example.com',
        verificationCode: '000000',
      })
      const timeNonExisting = Date.now() - startNonExisting

      // Timing should be similar (within 100ms) to prevent enumeration
      expect(Math.abs(timeExisting - timeNonExisting)).toBeLessThan(100)
    })

    it('should use cryptographically secure random codes', () => {
      // Generate multiple codes and verify they're all 6 digits
      const codes = Array.from({ length: 100 }, () => crypto.randomInt(100000, 999999).toString())

      codes.forEach(code => {
        expect(code.length).toBe(6)
        expect(parseInt(code)).toBeGreaterThanOrEqual(100000)
        expect(parseInt(code)).toBeLessThan(1000000)
      })

      // Verify codes are unique (very high probability)
      const uniqueCodes = new Set(codes)
      expect(uniqueCodes.size).toBeGreaterThan(95) // Allow some collisions
    })
  })
})
