/**
 * Corte por fases de los tokens legacy (Parte A, Task 15)
 *
 * Ver `docs/auth-rollout-legacy.md` para la narrativa completa (las 4 fases, la
 * aritmética de los 90 días, y quién mueve la bandera). Aquí sólo el contrato:
 *
 *  - Rutas normales (`authenticateTokenMiddleware`): un token SIN `sid` pasa mientras
 *    la fase efectiva del rollout sea 1-3. En cuanto la fase efectiva llega a 4 —a mano
 *    con `AUTH_LEGACY_TOKEN_PHASE=4`, o solo porque ya se cumplió `AUTH_LEGACY_TOKEN_
 *    CUTOFF_AT`— se rechaza en TODAS partes, incluidas las rutas de siempre.
 *  - "Lo nuevo" (`requireVersionedSession`, el candado que `switch-user` va a heredar en
 *    la Parte C): rechaza un token SIN `sid` SIEMPRE, desde el día 1 de la fase 1, sin
 *    importar la bandera ni la fecha.
 *  - El corte es sobre la AUSENCIA de `sid`, nunca sobre la fecha por sí sola: un token
 *    CON `sid` sigue su propio ciclo de vida (`isSessionAliveCached`), haya pasado o no
 *    la fecha de corte.
 *
 * Mismo patrón de mocking que los archivos hermanos de este directorio
 * (`authenticateToken.middleware.test.ts`, `authenticateToken.session.test.ts`): la
 * implementación real llama a `jwt.verify` (paquete `jsonwebtoken`) directamente, así
 * que aquí se mockea `jsonwebtoken`, no un servicio intermedio.
 */
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { authenticateTokenMiddleware, requireVersionedSession } from '@/middlewares/authenticateToken.middleware'
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

const ENV_PHASE = 'AUTH_LEGACY_TOKEN_PHASE'
const ENV_CUTOFF = 'AUTH_LEGACY_TOKEN_CUTOFF_AT'

describe('corte de tokens legacy', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let statusMock: jest.Mock
  let jsonMock: jest.Mock
  let clearCookieMock: jest.Mock
  let envPhaseOriginal: string | undefined
  let envCutoffOriginal: string | undefined

  beforeEach(() => {
    jest.clearAllMocks()

    // Aislar cada prueba de la bandera y la fecha: sin esto, una prueba que las fija
    // (para simular "ya pasó el corte") contaminaría a las que corren después.
    envPhaseOriginal = process.env[ENV_PHASE]
    envCutoffOriginal = process.env[ENV_CUTOFF]
    delete process.env[ENV_PHASE]
    delete process.env[ENV_CUTOFF]

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

  afterEach(() => {
    if (envPhaseOriginal === undefined) delete process.env[ENV_PHASE]
    else process.env[ENV_PHASE] = envPhaseOriginal
    if (envCutoffOriginal === undefined) delete process.env[ENV_CUTOFF]
    else process.env[ENV_CUTOFF] = envCutoffOriginal
  })

  it('fase 1: un token SIN sid se acepta en las rutas normales', async () => {
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

    await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

    expect(sessionCache.isSessionAliveCached).not.toHaveBeenCalled()
    expect(mockNext).toHaveBeenCalledWith()
    expect((mockReq as any).authContext).toMatchObject({ userId: 'st1' })
  })

  it('🔴 fase 1: un token SIN sid se RECHAZA en switch-user', async () => {
    // Lo nuevo nunca se habilita para legacy, desde el primer dia.
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

    await requireVersionedSession(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).not.toHaveBeenCalledWith()
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'LEGACY_TOKEN_NOT_ALLOWED' }))
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('un token CON sid sí pasa por switch-user', async () => {
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', v: 1 })

    await requireVersionedSession(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('despues de la fecha de corte, un token sin sid se rechaza en TODAS partes', async () => {
    // Muy en el pasado: para cualquier "ahora" real de la corrida, ya se cumplió.
    process.env[ENV_CUTOFF] = '2020-01-01T00:00:00.000Z'
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

    await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).not.toHaveBeenCalledWith()
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'LEGACY_TOKEN_RETIRED' }))
    expect((mockReq as any).authContext).toBeUndefined()
    // Tampoco se coló por la rama de sesiones: nunca tuvo sid que consultar.
    expect(sessionCache.isSessionAliveCached).not.toHaveBeenCalled()
  })

  it('la bandera manual en fase 4 rechaza igual, sin esperar la fecha de corte', async () => {
    process.env[ENV_PHASE] = '4'
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

    await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'LEGACY_TOKEN_RETIRED' }))
  })

  it('un token CON sid emitido antes del corte sigue siendo valido', async () => {
    // El corte es sobre la AUSENCIA de sid, no sobre la fecha por si sola.
    process.env[ENV_CUTOFF] = '2020-01-01T00:00:00.000Z' // ya "pasó" para cualquier corrida real
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER', sid: 's1', v: 1 })
    ;(sessionCache.isSessionAliveCached as jest.Mock).mockResolvedValue(true)

    await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

    expect(sessionCache.isSessionAliveCached).toHaveBeenCalledWith('s1')
    expect(mockNext).toHaveBeenCalledWith()
    expect((mockReq as any).authContext).toMatchObject({ userId: 'st1' })
  })

  it('una fecha de corte en el futuro NO rechaza (todavía no se cumple)', async () => {
    process.env[ENV_CUTOFF] = '2099-01-01T00:00:00.000Z'
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

    await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
    expect((mockReq as any).authContext).toMatchObject({ userId: 'st1' })
  })

  it('una bandera invalida no escala la fase por si sola (ante la duda, no echa a nadie)', async () => {
    process.env[ENV_PHASE] = 'no-es-un-numero'
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'st1', venueId: 'v1', role: 'CASHIER' })

    await authenticateTokenMiddleware(mockReq as Request, mockRes as Response, mockNext)

    expect(mockNext).toHaveBeenCalledWith()
  })
})
