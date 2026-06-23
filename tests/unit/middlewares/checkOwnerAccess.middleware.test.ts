/**
 * checkOwnerAccess / checkOrganizationAccess Middleware Tests
 *
 * Focus of the NEW FEATURE tests: a transient DB error on the StaffVenue lookup
 * (P1017 connection closed, P2024 pool timeout) must be forwarded to next(error)
 * — NOT escape as a process-level unhandledRejection. Before the fix this bare
 * async middleware had no try/catch, so a rejecting await crashed production
 * (gracefulShutdown). See incident 2026-06-23.
 *
 * REGRESSION tests assert the normal auth/superadmin/owner/403 flows still work.
 */

import { Request, Response, NextFunction } from 'express'
import { checkOwnerAccess, checkOrganizationAccess } from '@/middlewares/checkOwnerAccess.middleware'
import prisma from '@/utils/prismaClient'

// Mock the StaffVenue model (only findFirst is used here).
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: {
      findFirst: jest.fn(),
    },
  },
}))

// '../security' re-exports the StaffRole enum; mock just that so the test does not
// pull in security.ts's transitive deps (jwt/bcrypt/env).
jest.mock('@/security', () => ({
  StaffRole: {
    SUPERADMIN: 'SUPERADMIN',
    OWNER: 'OWNER',
    ADMIN: 'ADMIN',
    MANAGER: 'MANAGER',
    CASHIER: 'CASHIER',
    WAITER: 'WAITER',
    KITCHEN: 'KITCHEN',
    HOST: 'HOST',
    VIEWER: 'VIEWER',
  },
}))

const dbError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code, meta: { modelName: 'StaffVenue' } })

describe('checkOwnerAccess Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)
    mockRes = { status: statusMock, json: jsonMock }
    mockNext = jest.fn()
    mockReq = {
      params: { orgId: 'org_123' },
      authContext: { userId: 'user_123', venueId: 'venue_123', orgId: 'org_123', role: 'MANAGER' },
    } as any
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: transient DB rejection is forwarded, not crashed
  // ──────────────────────────────────────────────────────────────────
  describe('transient DB error handling (the crash fix)', () => {
    it.each(['P1017', 'P2024'])('forwards a %s rejection to next(error) instead of escaping', async code => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValueOnce(dbError(code))

      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledTimes(1)
      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ code }))
      // It must NOT swallow the error into a self-produced response.
      expect(statusMock).not.toHaveBeenCalled()
    })

    it('does not reject the returned promise (no unhandledRejection escapes)', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValueOnce(dbError('P2024'))
      await expect(checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)).resolves.toBeUndefined()
    })

    it('forwards a non-DB error (e.g. unexpected TypeError) to next(error) too', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValueOnce(new TypeError('boom'))
      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)
      expect(mockNext).toHaveBeenCalledWith(expect.any(TypeError))
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: existing behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('regression: normal flows', () => {
    it('SUPERADMIN bypasses the DB check and calls next()', async () => {
      ;(mockReq as any).authContext.role = 'SUPERADMIN'
      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)
      expect(mockNext).toHaveBeenCalledWith()
      expect(prisma.staffVenue.findFirst).not.toHaveBeenCalled()
    })

    it('OWNER in the org calls next()', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'sv_1' })
      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)
      expect(mockNext).toHaveBeenCalledWith()
      expect(statusMock).not.toHaveBeenCalled()
    })

    it('non-owner gets 403, next() not called', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValueOnce(null)
      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('missing authContext → 401', async () => {
      ;(mockReq as any).authContext = undefined
      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)
      expect(statusMock).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('missing orgId → 400', async () => {
      ;(mockReq as any).params = {}
      await checkOwnerAccess(mockReq as Request, mockRes as Response, mockNext)
      expect(statusMock).toHaveBeenCalledWith(400)
      expect(mockNext).not.toHaveBeenCalled()
    })
  })
})

describe('checkOrganizationAccess Middleware (factory)', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)
    mockRes = { status: statusMock, json: jsonMock }
    mockNext = jest.fn()
    mockReq = {
      params: { orgId: 'org_123' },
      authContext: { userId: 'user_123', venueId: 'venue_123', orgId: 'org_123', role: 'MANAGER' },
    } as any
  })

  it('forwards a P2024 rejection to next(error) instead of escaping', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockRejectedValueOnce(dbError('P2024'))
    const mw = checkOrganizationAccess(true)
    await mw(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'P2024' }))
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('regression: allowAdmin=true lets an ADMIN through (next())', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'sv_admin' })
    const mw = checkOrganizationAccess(true)
    await mw(mockReq as Request, mockRes as Response, mockNext)
    expect(mockNext).toHaveBeenCalledWith()
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('regression: no matching role → 403', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValueOnce(null)
    const mw = checkOrganizationAccess(false)
    await mw(mockReq as Request, mockRes as Response, mockNext)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(mockNext).not.toHaveBeenCalled()
  })
})
