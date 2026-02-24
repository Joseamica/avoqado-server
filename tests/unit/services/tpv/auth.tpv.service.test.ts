import { staffSignIn } from '../../../../src/services/tpv/auth.tpv.service'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { StaffRole, VenueStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../../../../src/utils/prismaClient'
import * as security from '../../../../src/security'

// Mock dependencies
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    terminal: {
      findUnique: jest.fn(),
    },
    loyaltyConfig: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('../../../../src/security', () => ({
  __esModule: true,
  generateAccessToken: jest.fn(),
  generateRefreshToken: jest.fn(),
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}))

describe('TPV Auth Service - Venue-Specific PIN', () => {
  const mockStaffVenue = {
    id: 'staff-venue-1',
    staffId: 'staff-1',
    posStaffId: 'POS001',
    venueId: 'venue-1',
    pin: '1234', // PIN is now venue-specific on StaffVenue
    role: StaffRole.WAITER,
    permissions: null,
    totalSales: new Decimal('1000.00'),
    totalTips: new Decimal('100.00'),
    averageRating: new Decimal('4.5'),
    totalOrders: 50,
    active: true,
    startDate: new Date('2024-01-01'),
    endDate: null,
    staff: {
      id: 'staff-1',
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      phone: '+1234567890',
      employeeCode: 'EMP001',
      photoUrl: null,
      active: true,
    },
    venue: {
      id: 'venue-1',
      name: 'Test Restaurant',
      posType: null,
      posStatus: null,
      logo: null,
      status: VenueStatus.ACTIVE,
      organizationId: 'org-1',
    },
  }

  const mockTerminal = {
    id: 'terminal-1',
    name: 'Test Terminal',
    status: 'ACTIVE',
    activatedAt: new Date('2024-01-01'),
    venueId: 'venue-1',
  }

  beforeEach(() => {
    jest.clearAllMocks()

    // Mock environment variable
    process.env.ACCESS_TOKEN_SECRET = 'test-secret-key'

    // Setup default mocks
    ;(security.generateAccessToken as jest.Mock).mockReturnValue('mock-access-token')
    ;(security.generateRefreshToken as jest.Mock).mockReturnValue('mock-refresh-token')
    ;(prisma.staffVenue.update as jest.Mock).mockResolvedValue(mockStaffVenue)
    ;(prisma.terminal.findUnique as jest.Mock).mockResolvedValue(mockTerminal)
    // Mock loyaltyConfig lookup (added for loyalty program feature)
    ;(prisma.loyaltyConfig.findUnique as jest.Mock).mockResolvedValue({ active: false })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('staffSignIn', () => {
    it('should successfully sign in staff with valid PIN and venue', async () => {
      // Arrange
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(mockStaffVenue)

      // Act
      const result = await staffSignIn('venue-1', '1234', 'SERIAL-001')

      // Assert
      expect(result).toEqual({
        // Existing staff data
        id: 'staff-venue-1',
        staffId: 'staff-1',
        venueId: 'venue-1',
        role: StaffRole.WAITER,
        permissions: null,
        totalSales: new Decimal('1000.00'),
        totalTips: new Decimal('100.00'),
        averageRating: new Decimal('4.5'),
        totalOrders: 50,
        staff: mockStaffVenue.staff,
        venue: mockStaffVenue.venue,

        // JWT tokens
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 86400,
        tokenType: 'Bearer',

        // Metadata
        correlationId: expect.any(String),
        issuedAt: expect.any(String),

        // Loyalty program status
        loyaltyActive: false,
      })
    })

    it('should generate JWT tokens with correct payload', async () => {
      // Arrange
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(mockStaffVenue)

      // Act
      await staffSignIn('venue-1', '1234', 'SERIAL-001')

      // Assert
      expect(security.generateAccessToken).toHaveBeenCalledWith({
        userId: 'staff-1',
        staffId: 'staff-1',
        venueId: 'venue-1',
        orgId: 'org-1',
        role: StaffRole.WAITER,
        permissions: null,
        correlationId: expect.any(String),
        terminalSerialNumber: 'SERIAL-001',
      })

      expect(security.generateRefreshToken).toHaveBeenCalledWith({
        userId: 'staff-1',
        staffId: 'staff-1',
        venueId: 'venue-1',
        orgId: 'org-1',
        role: StaffRole.WAITER,
        permissions: null,
        correlationId: expect.any(String),
        terminalSerialNumber: 'SERIAL-001',
      })
    })

    it('should throw BadRequestError when PIN is missing', async () => {
      // Act & Assert
      await expect(staffSignIn('venue-1', '', 'SERIAL-001')).rejects.toThrow(BadRequestError)
      await expect(staffSignIn('venue-1', '', 'SERIAL-001')).rejects.toThrow('PIN es requerido')
    })

    it('should throw BadRequestError when venueId is missing', async () => {
      // Act & Assert
      await expect(staffSignIn('', '1234', 'SERIAL-001')).rejects.toThrow(BadRequestError)
      await expect(staffSignIn('', '1234', 'SERIAL-001')).rejects.toThrow('ID del venue es requerido')
    })

    it('should throw NotFoundError when staff not found', async () => {
      // Arrange
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)

      // Act & Assert
      await expect(staffSignIn('venue-1', '9999', 'SERIAL-001')).rejects.toThrow(NotFoundError)
      await expect(staffSignIn('venue-1', '9999', 'SERIAL-001')).rejects.toThrow('Pin Incorrecto')
    })

    it('should query database with correct venue-specific PIN parameters', async () => {
      // Arrange
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(mockStaffVenue)

      // Act
      await staffSignIn('venue-1', '1234', 'SERIAL-001')

      // Assert
      // Note: venue.status is NOT filtered in query - checked separately after finding staff
      // This allows distinguishing "wrong PIN" from "venue suspended" errors
      expect(prisma.staffVenue.findFirst).toHaveBeenCalledWith({
        where: {
          venueId: 'venue-1',
          pin: '1234',
          active: true,
          staff: {
            active: true,
          },
        },
        include: {
          staff: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              employeeCode: true,
              photoUrl: true,
              active: true,
            },
          },
          venue: {
            select: {
              id: true,
              name: true,
              slug: true,
              posType: true,
              posStatus: true,
              logo: true,
              status: true,
              organizationId: true,
            },
          },
        },
      })
    })

    it('should throw UnauthorizedError when venue is SUSPENDED', async () => {
      // Arrange - Staff exists but venue is suspended
      const suspendedVenueStaff = {
        ...mockStaffVenue,
        venue: {
          ...mockStaffVenue.venue,
          status: VenueStatus.SUSPENDED,
        },
      }
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(suspendedVenueStaff)

      // Act & Assert
      await expect(staffSignIn('venue-1', '1234', 'SERIAL-001')).rejects.toMatchObject({
        message: 'Este establecimiento está suspendido temporalmente. Contacta al administrador para más información.',
      })
    })

    it('should throw UnauthorizedError when venue is ADMIN_SUSPENDED', async () => {
      // Arrange - Staff exists but venue is admin suspended
      const adminSuspendedVenueStaff = {
        ...mockStaffVenue,
        venue: {
          ...mockStaffVenue.venue,
          status: VenueStatus.ADMIN_SUSPENDED,
        },
      }
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(adminSuspendedVenueStaff)

      // Act & Assert
      await expect(staffSignIn('venue-1', '1234', 'SERIAL-001')).rejects.toMatchObject({
        message: 'Este establecimiento ha sido suspendido por el administrador. Contacta a soporte para más información.',
      })
    })

    it('should throw UnauthorizedError when venue is CLOSED', async () => {
      // Arrange - Staff exists but venue is closed
      const closedVenueStaff = {
        ...mockStaffVenue,
        venue: {
          ...mockStaffVenue.venue,
          status: VenueStatus.CLOSED,
        },
      }
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(closedVenueStaff)

      // Act & Assert
      await expect(staffSignIn('venue-1', '1234', 'SERIAL-001')).rejects.toMatchObject({
        message: 'Este establecimiento ha sido cerrado permanentemente.',
      })
    })

    it('should handle database errors gracefully', async () => {
      // Arrange
      const dbError = new Error('Database connection failed')
      ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValue(dbError)

      // Act & Assert
      await expect(staffSignIn('venue-1', '1234', 'SERIAL-001')).rejects.toThrow(dbError)
    })

    it('should include correlation ID in response', async () => {
      // Arrange
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(mockStaffVenue)

      // Act
      const result = await staffSignIn('venue-1', '1234', 'SERIAL-001')

      // Assert
      expect(result.correlationId).toBeDefined()
      expect(typeof result.correlationId).toBe('string')
      expect(result.correlationId.length).toBeGreaterThan(0)
    })

    it('should include timestamp in response', async () => {
      // Arrange
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(mockStaffVenue)

      // Act
      const result = await staffSignIn('venue-1', '1234', 'SERIAL-001')

      // Assert
      expect(result.issuedAt).toBeDefined()
      expect(typeof result.issuedAt).toBe('string')
      expect(new Date(result.issuedAt)).toBeInstanceOf(Date)
    })
  })
})
