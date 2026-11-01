/**
 * El candado de los negocios demo corre dentro de `authenticateTokenMiddleware` (como la guardia de impersonación):
 * toda ruta con sesión queda cubierta sin acordarse de montarlo.
 */
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { buildAuthContextFromPayload } from '@/security'
import { isJtiRevoked } from '@/utils/tokenRevocation'
import { revisarCandadoDemo } from '@/services/demo/candadoDemo'

jest.mock('jsonwebtoken', () => {
  class TokenExpiredError extends Error {}
  class JsonWebTokenError extends Error {}
  const mod = { verify: jest.fn(), decode: jest.fn(), TokenExpiredError, JsonWebTokenError }
  return { __esModule: true, default: mod, ...mod }
})
jest.mock('@/security', () => ({ buildAuthContextFromPayload: jest.fn() }))
jest.mock('@/utils/tokenRevocation', () => ({ isJtiRevoked: jest.fn() }))
jest.mock('@/services/liveDemo.service', () => ({ updateLiveDemoActivity: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/demo/candadoDemo', () => ({ revisarCandadoDemo: jest.fn() }))

describe('authenticateTokenMiddleware + candado demo', () => {
  let res: Partial<Response>
  let status: jest.Mock
  let json: jest.Mock
  let next: NextFunction
  const req = () =>
    ({
      cookies: {},
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      originalUrl: '/api/v1/dashboard/venues/v/plan/checkout',
    }) as any

  beforeEach(() => {
    jest.clearAllMocks()
    json = jest.fn()
    status = jest.fn(() => res as Response)
    res = { status, json, clearCookie: jest.fn() }
    next = jest.fn()
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'u', jti: 'j' })
    ;(buildAuthContextFromPayload as jest.Mock).mockReturnValue({ userId: 'u', venueId: 'v', isImpersonating: false })
    ;(isJtiRevoked as jest.Mock).mockResolvedValue(false)
  })

  it('responde 403 NEGOCIO_DEMO con el mensaje y no sigue', async () => {
    ;(revisarCandadoDemo as jest.Mock).mockResolvedValue({ ok: false, status: 403, code: 'NEGOCIO_DEMO', message: 'Esto no se puede…' })
    await authenticateTokenMiddleware(req() as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden', code: 'NEGOCIO_DEMO', message: 'Esto no se puede…' })
    expect(next).not.toHaveBeenCalled()
  })

  it('regresión: si el candado deja pasar, la petición sigue igual que antes', async () => {
    ;(revisarCandadoDemo as jest.Mock).mockResolvedValue({ ok: true })
    await authenticateTokenMiddleware(req() as Request, res as Response, next)
    expect(next).toHaveBeenCalledWith()
    expect(status).not.toHaveBeenCalled()
  })
})
