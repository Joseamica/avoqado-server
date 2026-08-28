/**
 * authenticateTokenMiddleware + sesiones revocables (Parte A, Task 5)
 *
 * NEW FEATURE: un token que trae `sid` se valida contra `isSessionAliveCached`. Si la
 * sesión ya no vive (revocada / cerrada), la petición se rechaza — NUNCA arma
 * `req.authContext` ni llama a `next()` sin argumentos. Un token LEGACY (sin `sid`,
 * emitido antes de este rollout) pasa exactamente como hoy, SIN consultar la caché:
 * romper esa rama expulsaría de golpe a todo el producto (dashboard, PAX, Android, iOS)
 * el día que esto se despliegue, porque hay tokens vivos sin `sid` circulando.
 *
 * Sigue el mismo patrón de mocking que `authenticateToken.middleware.test.ts` (el
 * archivo hermano de este directorio): la implementación real llama a `jwt.verify`
 * (paquete `jsonwebtoken`) directamente, no a un `@/jwt.service` — así que aquí se
 * mockea `jsonwebtoken`, no un servicio intermedio.
 */
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { buildAuthContextFromPayload } from '@/security'
import { isJtiRevoked } from '@/utils/tokenRevocation'
import * as sessionCache from '@/services/auth/sessionCache'

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

jest.mock('@/services/auth/sessionCache', () => ({
  isSessionAliveCached: jest.fn(),
}))

jest.mock('@/services/liveDemo.service', () => ({
  updateLiveDemoActivity: jest.fn().mockResolvedValue(undefined),
}))

describe('authenticateTokenMiddleware + sesiones revocables', () => {
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

    // Defaults felices: token no revocado por jti, authContext neutro.
    ;(buildAuthContextFromPayload as jest.Mock).mockReturnValue({ userId: 'st1', isImpersonating: false })
    ;(isJtiRevoked as jest.Mock).mockResolvedValue(false)
  })

  // ──────────────────────────────────────────────────────────────────
  // NEW FEATURE
  // ──────────────────────────────────────────────────────────────────
  describe('token con sid', () => {
    it('rechaza un token cuya sesion fue revocada', async () => {
      ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', v: 1 })
      ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(false)

      await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

      expect(sessionCache.isSessionAliveCached).toHaveBeenCalledWith('s1')
      // no deja pasar: next() sin argumentos jamás se invoca (next(error) sí está permitido)
      expect(mockNext).not.toHaveBeenCalledWith()
      // sí se enteró el downstream: se propaga un error 401 vía next(error)
      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
      expect((mockReq as any).authContext).toBeUndefined()
    })

    it('deja pasar un token cuya sesion sigue viva', async () => {
      ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', v: 1 })
      ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)

      await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

      expect(sessionCache.isSessionAliveCached).toHaveBeenCalledWith('s1')
      expect(mockNext).toHaveBeenCalledWith()
      expect((mockReq as any).authContext).toMatchObject({ userId: 'st1' })
    })
  })

  // ──────────────────────────────────────────────────────────────────
  // REGRESSION: el legado (sin sid) no debe tocarse
  // ──────────────────────────────────────────────────────────────────
  describe('token legacy sin sid', () => {
    it('deja pasar un token legacy SIN sid, sin consultar la cache de sesion', async () => {
      ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

      await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

      expect(sessionCache.isSessionAliveCached).not.toHaveBeenCalled()
      expect(mockNext).toHaveBeenCalledWith()
      expect((mockReq as any).authContext).toMatchObject({ userId: 'st1' })
    })
  })
})
