// tests/unit/controllers/dashboard/auth.dashboard.controller.test.ts
import { Request, Response, NextFunction } from 'express'
import { Session, SessionData } from 'express-session'
import jwt from 'jsonwebtoken'
import prisma from '../../../../src/utils/prismaClient' // Adjusted path
import * as authController from '../../../../src/controllers/dashboard/auth.dashboard.controller'
import * as authService from '../../../../src/services/dashboard/auth.service' // Import for direct mock reference
import { AuthenticationError } from '../../../../src/errors/AppError'
import { StaffRole } from '@prisma/client'
import logger from '../../../../src/config/logger'
import '../../../../src/types/express.d.ts' // Import the type declarations

// Mock dependencies
jest.mock('jsonwebtoken')
jest.mock('../../../../src/config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}))
jest.mock('../../../../src/services/dashboard/auth.service', () => ({
  loginStaff: jest.fn(),
  switchVenueForStaff: jest.fn(), // Also mock other functions if they exist in the service
}))
jest.mock('../../../../src/utils/prismaClient', () => ({
  staff: {
    findUnique: jest.fn(),
  },
  venue: {
    findMany: jest.fn(),
  },
  venueRolePermission: {
    findMany: jest.fn(),
  },
  // Add other models and methods as needed for your tests
}))

// Mock Express req, res, next
const mockRequest = (
  cookiesArgs: Partial<Request['cookies']> = {},
  body: Partial<Request['body']> = {},
  params: Partial<Request['params']> = {},
  query: Partial<Request['query']> = {},
  sessionArgs: Partial<SessionData> = {},
  authContextArgs?: Request['authContext'], // Make it optional
): Partial<Request> => {
  const req: Partial<Request> = {}
  req.cookies = cookiesArgs
  req.body = body
  req.params = params as Request['params']
  req.query = query
  req.session = {
    id: 'mock-session-id',
    cookie: {
      originalMaxAge: null,
      maxAge: null,
      expires: null,
      httpOnly: true,
      path: '/',
      secure: false, // Adjust if testing over HTTPS
      sameSite: false, // Adjust based on your needs
      domain: undefined,
      encode: (val: string) => val,
    } as any, // Cast to any for simplicity, or import CookieOptions and fill properly
    destroy: jest.fn(),
    regenerate: jest.fn(),
    reload: jest.fn(),
    save: jest.fn(),
    touch: jest.fn(),
    resetMaxAge: jest.fn(), // Added missing resetMaxAge
    ...sessionArgs,
  } as Session
  if (authContextArgs) {
    req.authContext = authContextArgs
  }
  return req
}

const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.clearCookie = jest.fn().mockReturnValue(res)
  res.cookie = jest.fn().mockReturnValue(res)
  return res
}

const mockNext = jest.fn() as NextFunction

describe('Dashboard Auth Controller', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks()
  })

  describe('getAuthStatus', () => {
    it('should return authenticated: false if no token is present', async () => {
      const req = mockRequest()
      const res = mockResponse()

      await authController.getAuthStatus(req as Request, res as Response)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({
        authenticated: false,
        user: null,
      })
    })

    it('should return authenticated: false if token is invalid or staff not found', async () => {
      const req = mockRequest({ accessToken: 'invalid-token' })
      const res = mockResponse()
      ;(jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('jwt malformed')
      })

      await authController.getAuthStatus(req as Request, res as Response)

      expect(jwt.verify).toHaveBeenCalledWith('invalid-token', process.env.ACCESS_TOKEN_SECRET!)
      // Since jwt.verify throws, it should be caught and handled
      // Depending on exact error handling, this might clear cookie and return 200 or call next(error)
      // For this example, let's assume it clears cookie and returns 200 based on controller logic
      expect(res.clearCookie).toHaveBeenCalledWith('accessToken')
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({
        authenticated: false,
        user: null,
      })

      // Scenario: Token valid, but staff not found
      jest.clearAllMocks() // Reset mocks for next part of the test
      ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'user-id-not-found' })
      ;(prisma.staff.findUnique as jest.Mock).mockResolvedValue(null)

      await authController.getAuthStatus(req as Request, res as Response)
      expect(prisma.staff.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-id-not-found' },
        select: expect.any(Object), // Check controller for exact select fields
      })
      expect(res.clearCookie).toHaveBeenCalledWith('accessToken')
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({
        authenticated: false,
        user: null,
      })
    })

    it('should return authenticated: true and user data if token is valid and staff found', async () => {
      const req = mockRequest({ accessToken: 'valid-token' })
      const res = mockResponse()
      const mockStaffId = 'staff-123'
      const mockDecodedToken = { sub: mockStaffId }
      const mockStaffData = {
        id: mockStaffId,
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
        emailVerified: true,
        photoUrl: null,
        organizationId: 'org-123',
        venues: [
          {
            role: StaffRole.OWNER,
            venue: {
              id: 'venue-123',
              name: 'Test Venue',
              slug: 'test-venue',
              logo: null,
            },
          },
        ],
      }

      ;(jwt.verify as jest.Mock).mockReturnValue(mockDecodedToken)
      ;(prisma.staff.findUnique as jest.Mock).mockResolvedValue(mockStaffData)
      // Mock prisma.venue.findMany for OWNER role
      ;(prisma.venue.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'venue-123',
          name: 'Test Venue',
          slug: 'test-venue',
          logo: null,
        },
      ])
      // Mock prisma.venueRolePermission.findMany to return no custom permissions
      ;(prisma.venueRolePermission.findMany as jest.Mock).mockResolvedValue([])

      await authController.getAuthStatus(req as Request, res as Response)

      expect(jwt.verify).toHaveBeenCalledWith('valid-token', process.env.ACCESS_TOKEN_SECRET!)
      expect(prisma.staff.findUnique).toHaveBeenCalledWith({
        where: { id: mockStaffId },
        select: expect.any(Object), // Verify exact select in actual test
      })
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticated: true,
          user: expect.objectContaining({
            id: mockStaffId,
            firstName: 'Test',
            // ... other user fields based on controller's transformation
          }),
          // ... other properties like currentVenue, allVenues
        }),
      )
    })

    // TODO: Add more tests for different scenarios, e.g.:
    // - User is SUPERADMIN
    // - User has multiple venues
    // - Error handling for prisma calls
  })

  // TODO: Add describe blocks for dashboardLoginController, dashboardLogoutController, switchVenueController
  describe('dashboardLoginController', () => {
    const mockLoginData = { email: 'test@example.com', password: 'password123' }
    const mockStaff = {
      id: 'staff-123',
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      // ... other relevant staff properties
    }
    const mockAccessToken = 'mock-access-token'
    const mockRefreshToken = 'mock-refresh-token'

    beforeEach(() => {
      jest.clearAllMocks()
      // Mock NODE_ENV for cookie secure flag
      process.env.NODE_ENV = 'development' // Default to development
    })

    it('should successfully login, set cookies, and return user data', async () => {
      const req = mockRequest({}, mockLoginData)
      const res = mockResponse()
      const next = mockNext

      ;(authService.loginStaff as jest.Mock).mockResolvedValue({
        accessToken: mockAccessToken,
        refreshToken: mockRefreshToken,
        staff: mockStaff,
      })

      await authController.dashboardLoginController(req as Request, res as Response, next)

      expect(authService.loginStaff).toHaveBeenCalledWith(mockLoginData)
      expect(res.cookie).toHaveBeenCalledTimes(2)
      expect(res.cookie).toHaveBeenNthCalledWith(1, 'accessToken', mockAccessToken, {
        httpOnly: true,
        secure: false, // NODE_ENV = 'development'
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000,
        path: '/',
      })
      expect(res.cookie).toHaveBeenNthCalledWith(2, 'refreshToken', mockRefreshToken, {
        httpOnly: true,
        secure: false, // NODE_ENV = 'development'
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
      })
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Login exitoso',
        user: mockStaff,
      })
      expect(next).not.toHaveBeenCalled()
    })

    it('should set secure cookies if NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production'
      const req = mockRequest({}, mockLoginData)
      const res = mockResponse()
      const next = mockNext

      ;(authService.loginStaff as jest.Mock).mockResolvedValue({
        accessToken: mockAccessToken,
        refreshToken: mockRefreshToken,
        staff: mockStaff,
      })

      await authController.dashboardLoginController(req as Request, res as Response, next)

      expect(res.cookie).toHaveBeenNthCalledWith(1, 'accessToken', mockAccessToken, expect.objectContaining({ secure: true }))
      expect(res.cookie).toHaveBeenNthCalledWith(2, 'refreshToken', mockRefreshToken, expect.objectContaining({ secure: true }))
    })

    it('should call next with error if authService.loginStaff throws AuthenticationError', async () => {
      const req = mockRequest({}, mockLoginData)
      const res = mockResponse()
      const next = mockNext
      const authError = new AuthenticationError('Invalid credentials')

      ;(authService.loginStaff as jest.Mock).mockRejectedValue(authError)

      await authController.dashboardLoginController(req as Request, res as Response, next)

      expect(authService.loginStaff).toHaveBeenCalledWith(mockLoginData)
      expect(res.cookie).not.toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
      expect(res.json).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith(authError)
    })

    it('should call next with error if authService.loginStaff throws an unexpected error', async () => {
      const req = mockRequest({}, mockLoginData)
      const res = mockResponse()
      const next = mockNext
      const unexpectedError = new Error('Something went wrong')

      ;(authService.loginStaff as jest.Mock).mockRejectedValue(unexpectedError)

      await authController.dashboardLoginController(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith(unexpectedError)
    })
  })
  describe('dashboardLogoutController', () => {
    beforeEach(() => {
      jest.clearAllMocks()
      process.env.NODE_ENV = 'development' // Default to development
      // Mock console.error for tests that might trigger it
      jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      // Restore console.error mock
      ;(console.error as jest.Mock).mockRestore()
    })

    it('should clear cookies, destroy session, and return success', async () => {
      const mockSessionDestroy = jest.fn(callback => callback())
      const req = mockRequest()
      req.session = { destroy: mockSessionDestroy } as any // Mock session object
      const res = mockResponse()

      await authController.dashboardLogoutController(req as Request, res as Response)

      expect(res.clearCookie).toHaveBeenCalledTimes(2)
      expect(res.clearCookie).toHaveBeenNthCalledWith(1, 'accessToken', {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
      })
      expect(res.clearCookie).toHaveBeenNthCalledWith(2, 'refreshToken', {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
      })
      expect(mockSessionDestroy).toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Logout exitoso' })
    })

    it('should clear cookies and return success if no session exists', async () => {
      const req = mockRequest()
      req.session = undefined // No session
      const res = mockResponse()

      await authController.dashboardLogoutController(req as Request, res as Response)

      expect(res.clearCookie).toHaveBeenCalledTimes(2)
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Logout exitoso' })
    })

    it('should log an error if session destruction fails but still return success', async () => {
      const mockSessionError = new Error('Session destruction failed')
      const mockSessionDestroy = jest.fn(callback => callback(mockSessionError))
      const req = mockRequest()
      req.session = { destroy: mockSessionDestroy } as any
      const res = mockResponse()

      await authController.dashboardLogoutController(req as Request, res as Response)

      expect(mockSessionDestroy).toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('Error al destruir sesión:', mockSessionError)
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Logout exitoso' })
    })

    it('should set secure cookies if NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production'
      const req = mockRequest()
      req.session = { destroy: jest.fn(cb => cb()) } as any
      const res = mockResponse()

      await authController.dashboardLogoutController(req as Request, res as Response)

      expect(res.clearCookie).toHaveBeenNthCalledWith(1, 'accessToken', expect.objectContaining({ secure: true }))
      expect(res.clearCookie).toHaveBeenNthCalledWith(2, 'refreshToken', expect.objectContaining({ secure: true }))
    })

    it('should throw AuthenticationError if res.clearCookie fails', async () => {
      const req = mockRequest()
      const res = mockResponse()
      const clearCookieError = new Error('Failed to clear cookie')
      ;(res.clearCookie as jest.Mock).mockImplementation(() => {
        throw clearCookieError
      })

      // We need to wrap the async call in a try/catch or expect.toThrow for async errors
      await expect(authController.dashboardLogoutController(req as Request, res as Response)).rejects.toThrow(
        new AuthenticationError('Error al cerrar sesión'),
      )
      expect(logger.error).toHaveBeenCalledWith('Error en logout:', clearCookieError)
    })
  })
  describe('switchVenueController', () => {
    const mockTargetVenueId = 'venue-target-456'
    const mockStaffId = 'staff-123'
    const mockOrgId = 'org-789'
    const mockNewAccessToken = 'new-access-token'
    const mockNewRefreshToken = 'new-refresh-token'

    beforeEach(() => {
      jest.clearAllMocks()
      process.env.NODE_ENV = 'development'
    })

    it('should switch venue, set new cookies, and return success', async () => {
      const req = mockRequest(
        {},
        { venueId: mockTargetVenueId },
        {},
        {},
        {},
        { userId: mockStaffId, orgId: mockOrgId, role: StaffRole.WAITER, venueId: 'venue-current-123' },
      )
      const res = mockResponse()
      const next = mockNext

      ;(authService.switchVenueForStaff as jest.Mock).mockResolvedValue({
        accessToken: mockNewAccessToken,
        refreshToken: mockNewRefreshToken,
      })

      await authController.switchVenueController(req as Request, res as Response, next)

      expect(authService.switchVenueForStaff).toHaveBeenCalledWith(mockStaffId, mockOrgId, mockTargetVenueId)
      expect(res.cookie).toHaveBeenCalledTimes(2)
      expect(res.cookie).toHaveBeenNthCalledWith(1, 'accessToken', mockNewAccessToken, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000,
        path: '/',
      })
      expect(res.cookie).toHaveBeenNthCalledWith(2, 'refreshToken', mockNewRefreshToken, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
      })
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Contexto de venue actualizado correctamente.' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should set secure cookies if NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production'
      const req = mockRequest(
        {},
        { venueId: mockTargetVenueId },
        {},
        {},
        {},
        { userId: mockStaffId, orgId: mockOrgId, role: StaffRole.WAITER, venueId: 'venue-current-123' },
      )
      const res = mockResponse()
      const next = mockNext

      ;(authService.switchVenueForStaff as jest.Mock).mockResolvedValue({
        accessToken: mockNewAccessToken,
        refreshToken: mockNewRefreshToken,
      })

      await authController.switchVenueController(req as Request, res as Response, next)
      expect(res.cookie).toHaveBeenNthCalledWith(1, 'accessToken', mockNewAccessToken, expect.objectContaining({ secure: true }))
      expect(res.cookie).toHaveBeenNthCalledWith(2, 'refreshToken', mockNewRefreshToken, expect.objectContaining({ secure: true }))
    })

    it('should call next with AuthenticationError if authContext.userId is missing', async () => {
      const req = mockRequest(
        {},
        { venueId: mockTargetVenueId },
        {},
        {},
        {},
        { orgId: mockOrgId, role: StaffRole.WAITER, venueId: 'venue-current-123' } as any, // No userId, cast to any to satisfy partial type
      )
      const res = mockResponse()
      const next = mockNext

      await authController.switchVenueController(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith(new AuthenticationError('Contexto de autenticación inválido.'))
      expect(authService.switchVenueForStaff).not.toHaveBeenCalled()
    })

    it('should call next with AuthenticationError if authContext.orgId is missing', async () => {
      const req = mockRequest(
        {},
        { venueId: mockTargetVenueId },
        {},
        {},
        {},
        { userId: mockStaffId, role: StaffRole.WAITER, venueId: 'venue-current-123' } as any, // No orgId, cast to any
      )
      const res = mockResponse()
      const next = mockNext

      await authController.switchVenueController(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith(new AuthenticationError('Contexto de autenticación inválido.'))
      expect(authService.switchVenueForStaff).not.toHaveBeenCalled()
    })

    it('should call next with error if authService.switchVenueForStaff throws an error', async () => {
      const serviceError = new Error('Service failed')
      const req = mockRequest(
        {},
        { venueId: mockTargetVenueId },
        {},
        {},
        {},
        { userId: mockStaffId, orgId: mockOrgId, role: StaffRole.WAITER, venueId: 'venue-current-123' },
      )
      const res = mockResponse()
      const next = mockNext

      ;(authService.switchVenueForStaff as jest.Mock).mockRejectedValue(serviceError)

      await authController.switchVenueController(req as Request, res as Response, next)

      expect(next).toHaveBeenCalledWith(serviceError)
    })
  })
})
