/**
 * verifyAccess Middleware Tests
 *
 * Tests the unified permission middleware that handles:
 * 1. SUPERADMIN bypass
 * 2. Core permission checks
 * 3. White-label feature access
 * 4. Fail-closed error handling
 */

import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { verifyAccess } from '@/middlewares/verifyAccess.middleware'
import * as accessService from '@/services/access/access.service'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: {
      findFirst: jest.fn(),
    },
  },
}))

jest.mock('@/services/access/access.service', () => ({
  getUserAccess: jest.fn(),
  hasPermission: jest.fn(),
  canAccessFeature: jest.fn(),
  createAccessCache: jest.fn(() => new Map()),
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

describe('verifyAccess Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const mockUserAccess: accessService.UserAccess = {
    userId: 'user_123',
    venueId: 'venue_123',
    organizationId: 'org_123',
    role: StaffRole.MANAGER,
    corePermissions: ['menu:read', 'orders:read'],
    whiteLabelEnabled: false,
    enabledFeatures: [],
    featureAccess: {},
  }

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
  })

  describe('Authentication Validation', () => {
    it('should return 403 if no authContext', async () => {
      mockReq.authContext = undefined
      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })

    it('should return 403 if no userId in authContext', async () => {
      ;(mockReq as any).authContext = { venueId: 'venue_123' }
      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })
  })

  describe('SUPERADMIN Bypass', () => {
    it('should allow SUPERADMIN to bypass all checks', async () => {
      // Mock user is SUPERADMIN
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_1' })

      const middleware = verifyAccess({ permission: 'admin:delete', featureCode: 'RESTRICTED_FEATURE' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith() // Called without error
      expect(accessService.getUserAccess).not.toHaveBeenCalled() // Skipped access check
    })
  })

  describe('Permission Checks', () => {
    beforeEach(() => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue(mockUserAccess)
    })

    it('should allow access when user has required permission', async () => {
      ;(accessService.hasPermission as jest.Mock).mockReturnValue(true)

      const middleware = verifyAccess({ permission: 'menu:read' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(accessService.hasPermission).toHaveBeenCalledWith(mockUserAccess, 'menu:read')
      expect(mockNext).toHaveBeenCalledWith()
    })

    it('should deny access when user lacks required permission', async () => {
      ;(accessService.hasPermission as jest.Mock).mockReturnValue(false)

      const middleware = verifyAccess({ permission: 'admin:delete' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })
  })

  describe('Feature Code Checks', () => {
    beforeEach(() => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue({
        ...mockUserAccess,
        whiteLabelEnabled: true,
        enabledFeatures: ['STORES_ANALYSIS'],
        featureAccess: {
          STORES_ANALYSIS: { allowed: true, dataScope: 'user-venues' },
        },
      })
    })

    it('should allow access when user has feature access', async () => {
      ;(accessService.canAccessFeature as jest.Mock).mockReturnValue({
        allowed: true,
        dataScope: 'user-venues',
      })

      const middleware = verifyAccess({ featureCode: 'STORES_ANALYSIS' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(accessService.canAccessFeature).toHaveBeenCalledWith(expect.anything(), 'STORES_ANALYSIS')
      expect(mockNext).toHaveBeenCalledWith()
    })

    it('should deny access when feature is not enabled', async () => {
      ;(accessService.canAccessFeature as jest.Mock).mockReturnValue({
        allowed: false,
        reason: 'FEATURE_NOT_ENABLED',
        dataScope: 'venue',
      })

      const middleware = verifyAccess({ featureCode: 'DISABLED_FEATURE' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })

    it('should deny access when role is not allowed for feature', async () => {
      ;(accessService.canAccessFeature as jest.Mock).mockReturnValue({
        allowed: false,
        reason: 'ROLE_NOT_ALLOWED',
        dataScope: 'venue',
      })

      const middleware = verifyAccess({ featureCode: 'ADMIN_ONLY_FEATURE' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })

    it('should attach dataScope to request when feature access granted', async () => {
      ;(accessService.canAccessFeature as jest.Mock).mockReturnValue({
        allowed: true,
        dataScope: 'organization',
      })

      const middleware = verifyAccess({ featureCode: 'STORES_ANALYSIS' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect((mockReq as any).whiteLabelDataScope).toBe('organization')
      expect((mockReq as any).whiteLabelFeatureCode).toBe('STORES_ANALYSIS')
    })
  })

  describe('requireWhiteLabel Option', () => {
    it('should deny access when requireWhiteLabel=true but venue has no white-label', async () => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue({
        ...mockUserAccess,
        whiteLabelEnabled: false,
      })

      const middleware = verifyAccess({ requireWhiteLabel: true })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })

    it('should allow access when requireWhiteLabel=true and venue has white-label', async () => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue({
        ...mockUserAccess,
        whiteLabelEnabled: true,
      })

      const middleware = verifyAccess({ requireWhiteLabel: true })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
    })
  })

  describe('Combined Permission + Feature Checks', () => {
    beforeEach(() => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue({
        ...mockUserAccess,
        whiteLabelEnabled: true,
      })
    })

    it('should require BOTH permission AND feature when requireBoth=true (default)', async () => {
      ;(accessService.hasPermission as jest.Mock).mockReturnValue(true)
      ;(accessService.canAccessFeature as jest.Mock).mockReturnValue({ allowed: false, reason: 'FEATURE_NOT_ENABLED', dataScope: 'venue' })

      const middleware = verifyAccess({ permission: 'analytics:read', featureCode: 'STORES_ANALYSIS' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })

    it('should require EITHER permission OR feature when requireBoth=false', async () => {
      ;(accessService.hasPermission as jest.Mock).mockReturnValue(true)
      ;(accessService.canAccessFeature as jest.Mock).mockReturnValue({ allowed: false, reason: 'FEATURE_NOT_ENABLED', dataScope: 'venue' })

      const middleware = verifyAccess({ permission: 'analytics:read', featureCode: 'STORES_ANALYSIS', requireBoth: false })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith() // Should pass because permission is granted
    })
  })

  describe('Fail-Closed Error Handling', () => {
    it('should deny access on unexpected errors (fail-closed)', async () => {
      ;(accessService.getUserAccess as jest.Mock).mockRejectedValue(new Error('Database connection failed'))

      const middleware = verifyAccess({ permission: 'menu:read' })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })

    it('should pass through ForbiddenError from getUserAccess', async () => {
      ;(accessService.getUserAccess as jest.Mock).mockRejectedValue(new Error('User has no access to venue'))

      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError))
    })
  })

  describe('Venue Access from URL Params', () => {
    it('should use venueId from URL params over authContext', async () => {
      mockReq.params = { venueId: 'different_venue_456' }
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue(mockUserAccess)

      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(accessService.getUserAccess).toHaveBeenCalledWith('user_123', 'different_venue_456', expect.any(Map))
    })

    it('should fallback to authContext.venueId if URL param not present', async () => {
      mockReq.params = {}
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue(mockUserAccess)

      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(accessService.getUserAccess).toHaveBeenCalledWith('user_123', 'venue_123', expect.any(Map))
    })
  })

  describe('Request-Level Caching', () => {
    it('should create and attach access cache to request', async () => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue(mockUserAccess)

      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(accessService.createAccessCache).toHaveBeenCalled()
      expect((mockReq as any).accessCache).toBeDefined()
    })

    it('should reuse existing cache if already on request', async () => {
      const existingCache = new Map()
      ;(mockReq as any).accessCache = existingCache
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue(mockUserAccess)

      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(accessService.createAccessCache).not.toHaveBeenCalled()
      expect(accessService.getUserAccess).toHaveBeenCalledWith('user_123', 'venue_123', existingCache)
    })
  })

  describe('Attaches UserAccess to Request', () => {
    it('should attach access object to request for use in controllers', async () => {
      ;(accessService.getUserAccess as jest.Mock).mockResolvedValue(mockUserAccess)

      const middleware = verifyAccess({})

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect((mockReq as any).access).toEqual(mockUserAccess)
    })
  })
})
