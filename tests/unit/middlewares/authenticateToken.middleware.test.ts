/**
 * authenticateTokenMiddleware Tests
 *
 * NEW FEATURE focus: a transient error (P1017/P2024) thrown by an awaited step inside the
 * auth middleware — the JTI-revocation check or the impersonation guard — must NOT escape
 * as a process-level unhandledRejection (the 2026-06-23 crash class). The middleware already
 * wraps its awaits in try/catch; these tests LOCK IN that containment.
 *
 * NOTE on terminal behavior: this middleware's catch RESPONDS directly with 401 (it does not
 * call next(error)). So the invariant under test is "the rejection is contained and the
 * request settles with a response", NOT "next(error) is called". (A transient blip surfacing
 * as 401 rather than 500 is a pre-existing semantic of the auth contract — out of scope here;
 * what matters for this crash fix is that nothing escapes.)
 *
 * REGRESSION: a valid token attaches req.authContext + next(); a missing token → 401.
 */
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { buildAuthContextFromPayload } from '@/security'
import { isJtiRevoked } from '@/utils/tokenRevocation'
import { enforceImpersonationRules } from '@/middlewares/impersonationGuard.middleware'

jest.mock('jsonwebtoken', () => {
  class TokenExpiredError extends Error {}
  class JsonWebTokenError extends Error {}
  const mod = { verify: jest.fn(), decode: jest.fn(), TokenExpiredError, JsonWebTokenError }
  return { __esModule: true, default: mod, ...mod }
})

jest.mock('@/security', () => ({
  buildAuthContextFromPayload: jest.fn(),
}))

jest.mock('@/utils/tokenRevocation', () => ({
  isJtiRevoked: jest.fn(),
}))

jest.mock('@/middlewares/impersonationGuard.middleware', () => ({
  enforceImpersonationRules: jest.fn(),
}))

jest.mock('@/services/liveDemo.service', () => ({
  updateLiveDemoActivity: jest.fn().mockResolvedValue(undefined),
}))

const dbError = (code: string) => Object.assign(new Error(`transient ${code}`), { code })

describe('authenticateTokenMiddleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let statusMock: jest.Mock
  let jsonMock: jest.Mock
  let clearCookieMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)
    clearCookieMock = jest.fn()
    mockRes = { status: statusMock, json: jsonMock, clearCookie: clearCookieMock }
    mockNext = jest.fn()
    mockReq = { cookies: {}, headers: { authorization: 'Bearer valid.jwt.token' } } as any

    // Happy defaults: a valid, non-impersonation token that is not revoked.
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'user_123', jti: 'jti_1' })
    ;(buildAuthContextFromPayload as jest.Mock).mockReturnValue({ userId: 'user_123', isImpersonating: false })
    ;(isJtiRevoked as jest.Mock).mockResolvedValue(false)
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE: transient rejection is contained, never escapes
  // ──────────────────────────────────────────────────────────────────
  describe('async rejection containment (the crash class)', () => {
    it('does not escape when the JTI-revocation check rejects (P2024) — settles with 401', async () => {
      ;(isJtiRevoked as jest.Mock).mockRejectedValueOnce(dbError('P2024'))

      await expect(authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)).resolves.toBeUndefined()
      expect(statusMock).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('does not escape when the impersonation guard rejects (P1017) — settles with 401', async () => {
      ;(buildAuthContextFromPayload as jest.Mock).mockReturnValue({ userId: 'user_123', isImpersonating: true })
      ;(enforceImpersonationRules as jest.Mock).mockRejectedValueOnce(dbError('P1017'))

      await expect(authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)).resolves.toBeUndefined()
      expect(statusMock).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: existing behavior unchanged
  // ──────────────────────────────────────────────────────────────────
  describe('regression: normal flows', () => {
    it('attaches authContext and calls next() for a valid token', async () => {
      await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

      expect((mockReq as any).authContext).toMatchObject({ userId: 'user_123' })
      expect(mockNext).toHaveBeenCalledWith()
      expect(statusMock).not.toHaveBeenCalled()
    })

    it('responds 401 when no token is provided', async () => {
      mockReq.headers = {}
      ;(mockReq as any).cookies = {}

      await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

      expect(statusMock).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
      expect(jwt.verify).not.toHaveBeenCalled()
    })
  })
})
