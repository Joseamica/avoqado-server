/**
 * checkPermission Middleware Tests
 *
 * Tests the core permission middleware that handles:
 * 1. SUPERADMIN bypass
 * 2. Permission resolution with VenueRolePermission
 * 3. Multi-venue support (URL params vs token)
 * 4. Error handling
 */

import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { checkPermission, checkAnyPermission, checkAllPermissions } from '@/middlewares/checkPermission.middleware'
import * as permissionsLib from '@/lib/permissions'
import prisma from '@/utils/prismaClient'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    venueRolePermission: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('@/lib/permissions', () => ({
  hasPermission: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

describe('checkPermission Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      params: { venueId: 'venue_123' },
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'MANAGER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()

    // Default: not a superadmin
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    // Default: no custom permissions
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  describe('Authentication Validation', () => {
    it('should return 401 if no authContext', async () => {
      mockReq.authContext = undefined
      const middleware = checkPermission('tpv:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(401)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unauthorized',
        }),
      )
    })

    it('should return 401 if no userId in authContext', async () => {
      ;(mockReq as any).authContext = { venueId: 'venue_123' }
      const middleware = checkPermission('tpv:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(401)
    })

    it('should return 400 if no venueId available', async () => {
      mockReq.params = {}
      ;(mockReq as any).authContext = { userId: 'user_123' }
      const middleware = checkPermission('tpv:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(400)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Venue ID required',
        }),
      )
    })
  })

  describe('SUPERADMIN Bypass', () => {
    it('should allow SUPERADMIN to bypass permission checks', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_superadmin' })

      const middleware = checkPermission('admin:nuclear-launch')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
      expect(permissionsLib.hasPermission).not.toHaveBeenCalled()
    })
  })

  describe('Permission Checks', () => {
    it('should allow access when user has permission', async () => {
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.MANAGER, null, 'menu:read')
      expect(mockNext).toHaveBeenCalledWith()
    })

    it('should deny access when user lacks permission', async () => {
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(false)

      const middleware = checkPermission('admin:delete')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden',
          required: 'admin:delete',
        }),
      )
    })

    it('should use custom permissions from VenueRolePermission', async () => {
      const customPerms = ['custom:read', 'custom:write']
      ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({
        permissions: customPerms,
      })
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('custom:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.MANAGER, customPerms, 'custom:read')
    })
  })

  describe('Multi-Venue Support', () => {
    it('should use venueId from URL params when different from token', async () => {
      mockReq.params = { venueId: 'different_venue_456' }
      ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({ role: StaffRole.ADMIN })
      ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(prisma.staffVenue.findUnique).toHaveBeenCalledWith({
        where: {
          staffId_venueId: {
            staffId: 'user_123',
            venueId: 'different_venue_456',
          },
        },
        select: { role: true },
      })
      expect(permissionsLib.hasPermission).toHaveBeenCalledWith(StaffRole.ADMIN, null, 'menu:read')
    })

    it('should return 403 when user has no access to URL venue', async () => {
      mockReq.params = { venueId: 'inaccessible_venue' }
      ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue(null)

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'No access to this venue',
        }),
      )
    })
  })

  describe('Error Handling', () => {
    it('should return 500 on unexpected errors', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValue(new Error('Database error'))

      const middleware = checkPermission('menu:read')

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(500)
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal Server Error',
        }),
      )
    })
  })
})

describe('checkAnyPermission Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      params: { venueId: 'venue_123' },
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'MANAGER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  it('should allow access if user has ANY of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock)
      .mockReturnValueOnce(false) // First permission
      .mockReturnValueOnce(true) // Second permission

    const middleware = checkAnyPermission(['admin:delete', 'menu:read'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
  })

  it('should deny access if user has NONE of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(false)

    const middleware = checkAnyPermission(['admin:delete', 'admin:nuclear'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(statusMock).toHaveBeenCalledWith(403)
  })
})

describe('checkAllPermissions Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      params: { venueId: 'venue_123' },
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'MANAGER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  it('should allow access if user has ALL of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock).mockReturnValue(true)

    const middleware = checkAllPermissions(['menu:read', 'orders:read'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
    expect(permissionsLib.hasPermission).toHaveBeenCalledTimes(2)
  })

  it('should deny access if user is missing ANY of the permissions', async () => {
    ;(permissionsLib.hasPermission as jest.Mock)
      .mockReturnValueOnce(true) // First permission
      .mockReturnValueOnce(false) // Second permission

    const middleware = checkAllPermissions(['menu:read', 'admin:delete'])

    await middleware(mockReq as Request, mockRes as Response, mockNext)

    expect(statusMock).toHaveBeenCalledWith(403)
  })
})
