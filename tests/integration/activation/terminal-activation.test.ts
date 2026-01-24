/**
 * Terminal Activation System Integration Tests
 *
 * ⚠️ CRITICAL: Tests the hybrid activation system (Serial Number + Activation Code)
 * similar to Square POS device activation flow.
 *
 * Tests:
 * - Generate activation code (protected endpoint)
 * - Activate terminal with valid code
 * - Code expiration (7 days)
 * - Anti-brute force (max 5 attempts)
 * - Case-insensitive code matching
 * - Single-use codes (cleared after activation)
 *
 * Uses REAL PostgreSQL database, NOT mocks!
 */

import prisma from '@/utils/prismaClient'
import { generateActivationCode, activateTerminal } from '@/services/dashboard/terminal-activation.service'
import { BadRequestError, UnauthorizedError, NotFoundError } from '@/errors/AppError'

// Increase timeout for integration tests
jest.setTimeout(60000)

describe('Terminal Activation System Integration', () => {
  // Test data
  const testVenueId = 'test_venue_activation_int_123'
  const testOrgId = 'test_org_activation_int_123'
  const testStaffId = 'test_staff_activation_int_123'
  const testTerminalId = 'test_terminal_activation_int_123'
  const testSerialNumber = 'AVQ-TEST-INT-12345'

  // Setup: Create test organization, venue and terminal before all tests
  beforeAll(async () => {
    // Clean up any existing test data
    await prisma.terminal.deleteMany({ where: { serialNumber: testSerialNumber } })
    await prisma.venue.deleteMany({ where: { id: testVenueId } })
    await prisma.organization.deleteMany({ where: { id: testOrgId } })

    // Create test organization
    await prisma.organization.create({
      data: {
        id: testOrgId,
        name: 'Test Organization for Activation',
        email: 'test-activation@example.com',
        phone: '+52 55 1234 5678',
      },
    })

    // Create test venue
    await prisma.venue.create({
      data: {
        id: testVenueId,
        name: 'Test Venue for Activation',
        slug: 'test-activation-venue-int',
        organizationId: testOrgId,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })

    // Create test terminal (NOT activated)
    await prisma.terminal.create({
      data: {
        id: testTerminalId,
        serialNumber: testSerialNumber,
        name: 'Test Terminal',
        type: 'TPV_ANDROID',
        status: 'INACTIVE',
        venueId: testVenueId,
      },
    })
  })

  // Cleanup: Remove test data after all tests
  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { serialNumber: testSerialNumber } })
    await prisma.venue.deleteMany({ where: { id: testVenueId } })
    await prisma.organization.deleteMany({ where: { id: testOrgId } })
    await prisma.$disconnect()
  })

  // Reset terminal activation state before each test
  beforeEach(async () => {
    await prisma.terminal.update({
      where: { id: testTerminalId },
      data: {
        activationCode: null,
        activationCodeExpiry: null,
        activatedAt: null,
        activatedBy: null,
        activationAttempts: 0,
        lastActivationAttempt: null,
        status: 'INACTIVE',
      },
    })
  })

  describe('Generate Activation Code', () => {
    it('should generate a valid 6-character alphanumeric code', async () => {
      const result = await generateActivationCode(testTerminalId, testStaffId)

      expect(result).toHaveProperty('activationCode')
      expect(result.activationCode).toMatch(/^[A-Z0-9]{6}$/) // 6 alphanumeric chars
      expect(result).toHaveProperty('expiresAt')
      expect(result).toHaveProperty('expiresIn', 7 * 24 * 60 * 60) // 7 days in seconds
      expect(result).toHaveProperty('terminalId', testTerminalId)
      expect(result).toHaveProperty('serialNumber', testSerialNumber)
      expect(result).toHaveProperty('venueName', 'Test Venue for Activation')

      // Verify code was saved in database
      const terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activationCode).toBe(result.activationCode)
      expect(terminal?.activationCodeExpiry).toBeTruthy()
      expect(terminal?.activatedBy).toBe(testStaffId)
      expect(terminal?.activationAttempts).toBe(0)
    })

    it('should throw BadRequestError when terminal is already activated', async () => {
      // Pre-activate terminal
      await prisma.terminal.update({
        where: { id: testTerminalId },
        data: {
          activatedAt: new Date(),
          status: 'ACTIVE',
        },
      })

      await expect(generateActivationCode(testTerminalId, testStaffId)).rejects.toThrow(BadRequestError)
      await expect(generateActivationCode(testTerminalId, testStaffId)).rejects.toThrow('already activated')
    })

    it('should throw NotFoundError when terminal does not exist', async () => {
      const fakeTerminalId = 'fake_terminal_999'
      await expect(generateActivationCode(fakeTerminalId, testStaffId)).rejects.toThrow(NotFoundError)
    })
  })

  describe('Activate Terminal', () => {
    let activationCode: string

    // Generate a valid activation code before each test
    beforeEach(async () => {
      const expiryDate = new Date()
      expiryDate.setDate(expiryDate.getDate() + 7) // 7 days from now

      activationCode = 'TEST123' // Fixed code for testing

      await prisma.terminal.update({
        where: { id: testTerminalId },
        data: {
          activationCode: activationCode,
          activationCodeExpiry: expiryDate,
          activatedBy: testStaffId,
          activationAttempts: 0,
        },
      })
    })

    it('should activate terminal successfully with valid code', async () => {
      const result = await activateTerminal(testSerialNumber, activationCode)

      expect(result).toHaveProperty('venueId', testVenueId)
      expect(result).toHaveProperty('terminalId', testTerminalId)
      expect(result).toHaveProperty('venueName', 'Test Venue for Activation')
      expect(result).toHaveProperty('venueSlug', 'test-activation-venue-int')
      expect(result).toHaveProperty('activatedAt')

      // Verify terminal was activated in database
      const terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activatedAt).toBeTruthy()
      expect(terminal?.status).toBe('ACTIVE')
      expect(terminal?.activationCode).toBeNull() // Code cleared after use (single-use)
      expect(terminal?.activationCodeExpiry).toBeNull()
      expect(terminal?.activationAttempts).toBe(0)
    })

    it('should activate with case-insensitive code matching', async () => {
      const result = await activateTerminal(testSerialNumber, 'test123') // lowercase

      expect(result).toHaveProperty('venueId', testVenueId)
      expect(result).toHaveProperty('terminalId', testTerminalId)
    })

    it('should increment failed attempts on invalid code', async () => {
      // Make one failed attempt
      try {
        await activateTerminal(testSerialNumber, 'WRONG1')
      } catch (error: any) {
        expect(error).toBeInstanceOf(UnauthorizedError)
        expect(error.message).toContain('Invalid activation code')
        expect(error.message).toContain('attempt(s) remaining before lockout')
      }

      // Verify failed attempt was recorded
      const terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activationAttempts).toBe(1)
      expect(terminal?.lastActivationAttempt).toBeTruthy()
    })

    it('should lock terminal after 5 failed attempts (anti-brute force)', async () => {
      // Simulate 5 failed attempts
      for (let i = 0; i < 5; i++) {
        try {
          await activateTerminal(testSerialNumber, `WRONG${i}`)
        } catch {
          // Expected to throw
        }
      }

      // 6th attempt should be blocked
      await expect(activateTerminal(testSerialNumber, activationCode)).rejects.toThrow(UnauthorizedError)
      await expect(activateTerminal(testSerialNumber, activationCode)).rejects.toThrow('Terminal locked')
      await expect(activateTerminal(testSerialNumber, activationCode)).rejects.toThrow('too many failed activation attempts')

      // Verify terminal is locked
      const terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activationAttempts).toBe(5)
    })

    it('should reject expired activation code', async () => {
      // Set code expiry to the past
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1) // 1 day ago

      await prisma.terminal.update({
        where: { id: testTerminalId },
        data: {
          activationCodeExpiry: pastDate,
        },
      })

      await expect(activateTerminal(testSerialNumber, activationCode)).rejects.toThrow(BadRequestError)
      await expect(activateTerminal(testSerialNumber, activationCode)).rejects.toThrow('Activation code expired')
    })

    it('should return activation data when terminal is already activated (app reinstall handling)', async () => {
      // Pre-activate terminal
      const activationDate = new Date()
      await prisma.terminal.update({
        where: { id: testTerminalId },
        data: {
          activatedAt: activationDate,
          status: 'ACTIVE',
        },
      })

      // Should NOT throw error - returns activation data for app reinstalls
      const result = await activateTerminal(testSerialNumber, activationCode)

      expect(result).toHaveProperty('venueId', testVenueId)
      expect(result).toHaveProperty('terminalId', testTerminalId)
      expect(result).toHaveProperty('activatedAt')
      expect(result).toHaveProperty('venueName', 'Test Venue for Activation')
    })

    it('should throw NotFoundError when terminal serial number does not exist', async () => {
      await expect(activateTerminal('NON_EXISTENT_SERIAL', activationCode)).rejects.toThrow(NotFoundError)
      await expect(activateTerminal('NON_EXISTENT_SERIAL', activationCode)).rejects.toThrow('not registered')
    })
  })

  describe('Complete Activation Flow (End-to-End)', () => {
    it('should complete full flow: generate code → activate terminal', async () => {
      // Step 1: Generate activation code
      const generatedData = await generateActivationCode(testTerminalId, testStaffId)
      expect(generatedData.activationCode).toMatch(/^[A-Z0-9]{6}$/)

      // Step 2: Activate terminal using the code
      const activationResult = await activateTerminal(testSerialNumber, generatedData.activationCode)
      expect(activationResult.venueId).toBe(testVenueId)
      expect(activationResult.terminalId).toBe(testTerminalId)

      // Step 3: Verify terminal is fully activated
      const terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activatedAt).toBeTruthy()
      expect(terminal?.status).toBe('ACTIVE')
      expect(terminal?.activationCode).toBeNull() // Code cleared
      expect(terminal?.activatedBy).toBe(testStaffId)

      // Step 4: Verify cannot generate new code after activation
      await expect(generateActivationCode(testTerminalId, testStaffId)).rejects.toThrow(BadRequestError)
      await expect(generateActivationCode(testTerminalId, testStaffId)).rejects.toThrow('already activated')

      // Step 5: Verify activation again returns success (app reinstall handling)
      const reactivationResult = await activateTerminal(testSerialNumber, generatedData.activationCode)
      expect(reactivationResult.venueId).toBe(testVenueId)
      expect(reactivationResult.terminalId).toBe(testTerminalId)
      expect(reactivationResult).toHaveProperty('activatedAt')
    })

    it('should generate unique codes for multiple terminals', async () => {
      // Create a second terminal
      const testTerminalId2 = 'test_terminal_activation_int_456'
      const testSerialNumber2 = 'AVQ-TEST-INT-67890'

      await prisma.terminal.create({
        data: {
          id: testTerminalId2,
          serialNumber: testSerialNumber2,
          name: 'Test Terminal 2',
          type: 'TPV_ANDROID',
          status: 'INACTIVE',
          venueId: testVenueId,
        },
      })

      // Generate codes for both terminals
      const code1 = await generateActivationCode(testTerminalId, testStaffId)
      const code2 = await generateActivationCode(testTerminalId2, testStaffId)

      // Codes should be different
      expect(code1.activationCode).not.toBe(code2.activationCode)
      expect(code1.terminalId).toBe(testTerminalId)
      expect(code2.terminalId).toBe(testTerminalId2)

      // Cleanup
      await prisma.terminal.delete({ where: { id: testTerminalId2 } })
    })
  })

  describe('Security & Edge Cases', () => {
    it('should clear code after successful activation (single-use)', async () => {
      // Generate and activate
      const { activationCode } = await generateActivationCode(testTerminalId, testStaffId)
      await activateTerminal(testSerialNumber, activationCode)

      // Verify code is cleared
      const terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activationCode).toBeNull()
      expect(terminal?.activationCodeExpiry).toBeNull()
    })

    it('should reset activation attempts after successful activation', async () => {
      // Generate code
      const { activationCode } = await generateActivationCode(testTerminalId, testStaffId)

      // Make 2 failed attempts
      for (let i = 0; i < 2; i++) {
        try {
          await activateTerminal(testSerialNumber, 'WRONG_CODE')
        } catch {
          // Expected
        }
      }

      // Verify 2 failed attempts recorded
      let terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activationAttempts).toBe(2)

      // Successful activation
      await activateTerminal(testSerialNumber, activationCode)

      // Verify attempts reset to 0
      terminal = await prisma.terminal.findUnique({ where: { id: testTerminalId } })
      expect(terminal?.activationAttempts).toBe(0)
    })

    it('should validate code format and length', async () => {
      // Code must be exactly 6 characters
      const { activationCode } = await generateActivationCode(testTerminalId, testStaffId)
      expect(activationCode).toHaveLength(6)

      // Code should only contain alphanumeric characters
      expect(activationCode).toMatch(/^[A-Z0-9]+$/)
    })
  })
})
